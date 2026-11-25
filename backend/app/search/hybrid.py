"""Hybrid policy search: an exact policy ID, PostgreSQL full-text keywords and pgvector meaning in one ranking.

Three signals, because each one catches what the others miss:
- ID: "EMAIL-01" is the most precise request an agent can make, so a policy named by ID ranks first.
- Keywords: a stored, weighted tsvector (title words carry weight A) finds exact terms like "cap".
- Meaning: cosine similarity between embeddings finds paraphrases that share no words ("money back" vs "refund").

Each policy's relevance = (keyword coverage + meaning similarity) / 2, plus 1.0 when the query names its ID. Keyword
coverage is the share of the query's word points a paragraph earns: one point per distinct query word it contains, and
two more when the word is also in the policy's title, because a title names what the policy is about. Repeating a word
earns nothing, so a paragraph that covers more of the question beats one that says a single word often.

Why not Reciprocal Rank Fusion, which this module used first: with 8 policies, 1 / (60 + rank) reduces fusion to the
sum of the two ranks, so a clear keyword lead counted no more than one place in the meaning list. bge-small gives most
on-topic policies 0.72-0.79, a nearly flat list, yet it decided the order: "late shipment refund" ranked EXCLUDE-01
first, although AMOUNT-01 has all three words in its title. Averaging the scores keeps their sizes: a big keyword lead
wins, and meaning decides between policies that share as many words, or alone when no word is shared.

Every query reads only rows embedded by the active model, so counts, IDs, keywords and vectors describe one index.
If the query cannot be embedded (the model failed to load, say), search still answers from IDs and keywords and
reports "mode": "keyword", so the agent keeps getting evidence.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any, Literal, NotRequired, TypedDict

from sqlalchemy import (
    CTE,
    ColumnElement,
    Float,
    ScalarSelect,
    SQLColumnExpression,
    Text,
    any_,
    cast,
    func,
    literal_column,
    select,
)
from sqlalchemy.dialects.postgresql import ARRAY, TSQUERY
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import PolicyChunk
from app.search.embeddings import Embedder

logger = logging.getLogger(__name__)

ID_MATCH_SCORE = 1.0
"""The most that keyword coverage and meaning similarity can reach together, so a named policy ranks first."""
TITLE_WORD_BONUS = 2
"""Extra points for a query word in the policy title, so a title word counts three times.

With one extra point, LATE-01 ("Late shipment eligibility": two title words) tied EXCLUDE-01 ("Refund exclusions":
one title word, two more in its paragraph) for "late shipment refund", and the nearly flat meaning scores sank it.
"""
CANDIDATES = 20
"""How many paragraphs each ranking passes to the fusion step."""
POLICY_ID = re.compile(r"\b[A-Za-z]+-\d+\b")
EMPTY_INDEX_MESSAGE = "The policy index is empty. Run python -m app.seed to build it."
NO_MATCH_MESSAGE = "No policies matched the search terms."

type MatchReason = Literal["id", "keyword", "semantic"]


class PolicyMatch(TypedDict):
    id: str
    title: str
    version: str
    file: str
    excerpt: str
    relevance_score: float
    matched_by: list[MatchReason]
    similarity: float | None


class SearchMode(TypedDict):
    mode: Literal["hybrid", "keyword"]
    embedding_model: str


class PolicySearchResult(TypedDict):
    query: str
    matches: list[PolicyMatch]
    total_policies: int
    search: SearchMode
    message: NotRequired[str]


@dataclass(frozen=True)
class Hit:
    """A policy found by one signal, represented by its best paragraph."""

    policy_id: str
    title: str
    version: str
    file: str
    excerpt: str
    score: float = 1.0
    """This signal's strength from 0 to 1: keyword coverage, or cosine similarity for meaning (1 for a named ID)."""


HIT_COLUMNS = (PolicyChunk.policy_id, PolicyChunk.title, PolicyChunk.version, PolicyChunk.file, PolicyChunk.content)


def policy_ids_in(query: str) -> list[str]:
    """Policy IDs named in the query, upper-cased, in order of first mention: "email-01, EMAIL-01" -> ["EMAIL-01"]."""
    return list(dict.fromkeys(name.upper() for name in POLICY_ID.findall(query)))


def best_per_policy(hits: Iterable[Hit]) -> list[Hit]:
    """Collapse paragraphs to policies. Rows arrive best first, so each policy keeps its best paragraph and score."""
    best: dict[str, Hit] = {}
    for hit in hits:
        best.setdefault(hit.policy_id, hit)
    return list(best.values())


async def id_matches(session: AsyncSession, ids: Sequence[str], model: str) -> list[Hit]:
    """The named policies that exist in the index, each represented by its first paragraph."""
    if not ids:
        return []
    rows = await session.execute(
        select(*HIT_COLUMNS)
        .where(PolicyChunk.policy_id.in_(ids), PolicyChunk.chunk_index == 0, PolicyChunk.embedding_model == model)
        .order_by(PolicyChunk.file)
    )
    return [Hit(*row) for row in rows]


def any_query_word(query: str) -> ColumnElement[Any]:
    """The query as an OR tsquery, normalised exactly like the stored search_vector.

    to_tsvector stems the words and drops stop words with the same 'english' configuration as the index, strip()
    removes word positions, and joining the quoted lexemes with | turns "late shipment refund" into
    'late' | 'shipment' | 'refund'. PostgreSQL quotes every lexeme itself, so punctuation in the query cannot break
    the tsquery syntax. (websearch_to_tsquery would require every word, and would read "-word" as NOT.)
    """
    lexemes = cast(func.strip(func.to_tsvector("english", query)), Text)
    return cast(func.replace(lexemes, " ", " | "), TSQUERY)


def query_words(query: str) -> CTE:
    """The query's distinct words, stemmed and without stop words exactly as the stored search_vector was built."""
    lexemes = func.tsvector_to_array(func.to_tsvector("english", query))
    return select(func.unnest(lexemes).label("word")).cte("query_words")


def words_found(words: CTE, vector: SQLColumnExpression[Any]) -> ScalarSelect[int]:
    """How many query words occur in this tsvector; a word counts once however often the paragraph repeats it."""
    lexemes = func.tsvector_to_array(vector, type_=ARRAY(Text))
    return select(func.count()).select_from(words).where(words.c.word == any_(lexemes)).scalar_subquery()


def keyword_coverage(words: CTE) -> ColumnElement[float]:
    """Points earned out of points possible: 1 per query word in the row, TITLE_WORD_BONUS more if it is in the title.

    ts_filter keeps the weight-A lexemes, which the stored search_vector takes from the title. Every query word could
    earn 1 + TITLE_WORD_BONUS points, so 1.0 means every word appears in the title.
    """
    title = func.ts_filter(PolicyChunk.search_vector, literal_column("'{a}'"))
    points = words_found(words, PolicyChunk.search_vector) + TITLE_WORD_BONUS * words_found(words, title)
    possible = (1 + TITLE_WORD_BONUS) * select(func.count()).select_from(words).scalar_subquery()
    return cast(points, Float(asdecimal=False)) / func.nullif(possible, 0)


async def keyword_ranking(session: AsyncSession, query: str, model: str, limit: int = CANDIDATES) -> list[Hit]:
    """Paragraphs sharing at least one word with the query, highest keyword coverage first.

    The OR tsquery finds the candidates through the GIN index. ts_rank_cd only breaks ties in coverage, which decides
    the excerpt when two paragraphs of one policy cover the same words.
    """
    terms = any_query_word(query)
    coverage = keyword_coverage(query_words(query))
    rows = await session.execute(
        select(*HIT_COLUMNS, coverage)
        .where(PolicyChunk.embedding_model == model, PolicyChunk.search_vector.bool_op("@@")(terms))
        .order_by(
            coverage.desc(),
            func.ts_rank_cd(PolicyChunk.search_vector, terms).desc(),
            PolicyChunk.file,
            PolicyChunk.chunk_index,
        )
        .limit(limit)
    )
    return best_per_policy(Hit(*row) for row in rows)


async def semantic_ranking(
    session: AsyncSession, vector: list[float], model: str, min_similarity: float, limit: int = CANDIDATES
) -> list[Hit]:
    """Paragraphs whose meaning is close to the query's, nearest first; below min_similarity nothing counts.

    `<=>` is pgvector's cosine distance, so similarity = 1 - distance.
    """
    if not any(vector):
        return []  # Text without words embeds to the zero vector, whose cosine distance to every row is NaN.
    distance = PolicyChunk.embedding.cosine_distance(vector)
    rows = await session.execute(
        select(*HIT_COLUMNS, 1 - distance)
        # Written as a distance bound because NaN <= x is false, while 1 - NaN >= x would be true in PostgreSQL.
        .where(PolicyChunk.embedding_model == model, distance <= 1 - min_similarity)
        .order_by(distance, PolicyChunk.file, PolicyChunk.chunk_index)
        .limit(limit)
    )
    return best_per_policy(Hit(*row) for row in rows)


def fuse(by_id: Sequence[Hit], by_keyword: Sequence[Hit], by_meaning: Sequence[Hit]) -> list[PolicyMatch]:
    """Merge the three signals, best first; equal scores are ordered by file name.

    relevance = (keyword coverage + meaning similarity) / 2, where a signal that missed the policy counts 0, plus 1.0
    when the query names its ID. The excerpt is its best keyword paragraph, else its closest paragraph by meaning, else
    its first paragraph.
    """
    signals: tuple[tuple[MatchReason, Sequence[Hit]], ...] = (
        ("id", by_id),
        ("keyword", by_keyword),
        ("semantic", by_meaning),
    )
    reasons: dict[str, list[MatchReason]] = {}
    for reason, hits in signals:
        for hit in hits:
            reasons.setdefault(hit.policy_id, []).append(reason)
    named = {hit.policy_id for hit in by_id}
    coverage = {hit.policy_id: hit.score for hit in by_keyword}
    similarities = {hit.policy_id: hit.score for hit in by_meaning}
    scores = {
        policy_id: ID_MATCH_SCORE * (policy_id in named)
        + (coverage.get(policy_id, 0.0) + similarities.get(policy_id, 0.0)) / 2
        for policy_id in reasons
    }
    # Later lists overwrite earlier ones, which gives the excerpt its priority: keyword, then meaning, then ID.
    sources = {hit.policy_id: hit for hits in (by_id, by_meaning, by_keyword) for hit in hits}
    ranked = sorted(scores, key=lambda policy_id: (-scores[policy_id], sources[policy_id].file))
    return [to_match(sources[p], scores[p], reasons[p], similarities.get(p)) for p in ranked]


def to_match(source: Hit, score: float, reasons: list[MatchReason], similarity: float | None) -> PolicyMatch:
    return PolicyMatch(
        id=source.policy_id,
        title=source.title,
        version=source.version,
        file=source.file,
        excerpt=source.excerpt,
        relevance_score=round(score, 4),
        matched_by=reasons,
        similarity=None if similarity is None else round(similarity, 2),
    )


async def embed_query_or_none(embedder: Embedder, query: str) -> list[float] | None:
    """The query's vector, or None when the model fails, so the search falls back to IDs and keywords."""
    try:
        return await embedder.embed_query(query)
    except Exception:  # Any model failure (missing files, ONNX error) must not cost the agent its keyword results.
        logger.warning("Policy search could not embed the query; using ID and keyword matches only", exc_info=True)
        return None


async def count_policies(session: AsyncSession, model: str) -> int:
    """Distinct policies indexed with this model: the "of 8 policies" the agent and the console report."""
    query = select(func.count(PolicyChunk.policy_id.distinct())).where(PolicyChunk.embedding_model == model)
    return await session.scalar(query) or 0


async def search_policies(
    session: AsyncSession, embedder: Embedder, query: str, max_results: int
) -> PolicySearchResult:
    """Rank the indexed policies for one query and cite each match with an exact paragraph."""
    # Embed before the first SQL statement, so the model's slow first load never holds a database connection.
    vector = await embed_query_or_none(embedder, query)
    model = embedder.name
    by_meaning = [] if vector is None else await semantic_ranking(session, vector, model, embedder.min_similarity)
    by_id = await id_matches(session, policy_ids_in(query), model)
    by_keyword = await keyword_ranking(session, query, model)
    total = await count_policies(session, model)
    result = PolicySearchResult(
        query=query,
        matches=fuse(by_id, by_keyword, by_meaning)[:max_results],
        total_policies=total,
        search=SearchMode(mode="keyword" if vector is None else "hybrid", embedding_model=model),
    )
    if not result["matches"]:
        result["message"] = NO_MATCH_MESSAGE if total else EMPTY_INDEX_MESSAGE
    return result
