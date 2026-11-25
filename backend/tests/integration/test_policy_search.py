"""Hybrid policy search against a real pgvector database, indexed by the sessions fixture with HashingEmbedder."""

import logging
import os
import shutil
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings
from app.models import PolicyChunk
from app.runs.schemas import ToolFailure, ToolSuccess
from app.search.corpus import POLICIES_DIR, PolicyDocument, load_corpus
from app.search.embeddings import LOCAL_MIN_SIMILARITY, HashingEmbedder, LocalEmbedder
from app.search.hybrid import (
    EMPTY_INDEX_MESSAGE,
    ID_MATCH_SCORE,
    NO_MATCH_MESSAGE,
    keyword_ranking,
    search_policies,
)
from app.search.indexer import index_policies
from app.tools import ToolContext
from app.tools.registry import get_registry

type Sessions = async_sessionmaker[AsyncSession]

POLICY_FILES = {
    "SHIP-01": "01-shipping-commitments.md",
    "LATE-01": "02-late-shipment-eligibility.md",
    "AMOUNT-01": "03-refund-amount.md",
    "EXCLUDE-01": "04-exclusions.md",
    "PARTIAL-01": "05-partial-refunds.md",
    "DUP-01": "06-duplicate-requests.md",
    "EMAIL-01": "07-email-drafts.md",
    "REVIEW-01": "08-escalation.md",
}


class BrokenQueryEmbedder(HashingEmbedder):
    """Like a model whose files went missing after the index was built."""

    async def embed_query(self, text: str) -> list[float]:
        raise RuntimeError("model files are missing")


@pytest.fixture
def corpus(tmp_path: Path) -> Path:
    """A writable copy of the bundled policies."""
    copy = tmp_path / "policies"
    shutil.copytree(POLICIES_DIR, copy)
    return copy


async def test_each_policy_is_citable_by_id_with_an_exact_paragraph(db_session: AsyncSession) -> None:
    for policy_id, filename in POLICY_FILES.items():
        result = await search_policies(db_session, HashingEmbedder(), policy_id.lower(), 5)

        assert result["total_policies"] == 8, policy_id
        first = result["matches"][0]
        assert (first["id"], first["version"], first["file"]) == (policy_id, "v1", filename)
        assert first["matched_by"][0] == "id" and first["relevance_score"] >= ID_MATCH_SCORE, policy_id
        assert [match["id"] for match in result["matches"] if "id" in match["matched_by"]] == [policy_id]
        source = (POLICIES_DIR / filename).read_text(encoding="utf-8")
        assert source.startswith(f"# {first['title']}\n"), policy_id
        assert first["excerpt"] and first["excerpt"] in source, policy_id
        assert not first["excerpt"].startswith(("#", "Policy ")), policy_id


async def test_keywords_rank_the_matching_policy_first(db_session: AsyncSession) -> None:
    for query, expected in [
        ("refund amount cap", "AMOUNT-01"),
        ("escalation human approval", "REVIEW-01"),
        ("shipping commitments", "SHIP-01"),
    ]:
        result = await search_policies(db_session, HashingEmbedder(), query, 5)

        first = result["matches"][0]
        assert (first["id"], first["version"]) == (expected, "v1"), query
        assert "keyword" in first["matched_by"], query


async def test_keywords_match_any_query_word_and_weight_the_title(db_session: AsyncSession) -> None:
    query = "late shipment refund eligibility"
    every_word = PolicyChunk.search_vector.bool_op("@@")(func.websearch_to_tsquery("english", query))

    hits = await keyword_ranking(db_session, query, HashingEmbedder.name)

    # Requiring every word would find a single policy; any word finds all eight, which each contain some of them.
    assert await db_session.scalar(select(func.count()).where(every_word)) == 1
    assert len(hits) == 8
    # Four words, three points each: AMOUNT-01 has all four, three in its title; LATE-01 has three, all in its title.
    assert [hit.policy_id for hit in hits[:2]] == ["AMOUNT-01", "LATE-01"]
    assert [hit.score for hit in hits[:2]] == pytest.approx([10 / 12, 9 / 12])


async def test_title_words_lift_the_demo_query_above_paragraph_matches(db_session: AsyncSession) -> None:
    hits = await keyword_ranking(db_session, "late shipment refund", HashingEmbedder.name)

    # EXCLUDE-01, PARTIAL-01 and DUP-01 contain all three words, but only "refund" in their titles.
    scores = {hit.policy_id: hit.score for hit in hits}
    assert [hit.policy_id for hit in hits[:2]] == ["AMOUNT-01", "LATE-01"]
    assert [scores[policy] for policy in ("AMOUNT-01", "LATE-01", "EXCLUDE-01")] == pytest.approx([1, 6 / 9, 5 / 9])


def policy(policy_id: str, title: str, paragraph: str) -> PolicyDocument:
    return PolicyDocument(policy_id, title, "v1", f"{policy_id.lower()}.md", (paragraph,))


async def test_distinct_query_words_count_once_and_title_words_three_times(sessions: Sessions) -> None:
    documents = [
        policy("REPEAT-01", "Notes", "Refund the refund, then refund the refund once more."),
        policy("COVER-01", "Notes", "Refund the order and check the ledger."),
        policy("TITLE-01", "Ledger checks", "Refund the order."),
    ]
    async with sessions.begin() as session:
        await index_policies(session, HashingEmbedder(), documents)

    async with sessions() as session:
        hits = await keyword_ranking(session, "refund ledger", HashingEmbedder.name)

    # Two query words, three points each. REPEAT-01 says "refund" four times yet covers one word (1 point); COVER-01
    # covers both (2); TITLE-01 covers both and has "ledger" in its title (2 + 2).
    assert [hit.policy_id for hit in hits] == ["TITLE-01", "COVER-01", "REPEAT-01"]
    assert [hit.score for hit in hits] == pytest.approx([4 / 6, 2 / 6, 1 / 6])


async def test_case_punctuation_and_repeats_do_not_change_keyword_scores(db_session: AsyncSession) -> None:
    plain = await keyword_ranking(db_session, "ledger", HashingEmbedder.name)
    noisy = await keyword_ranking(db_session, "LEDGER, ledger!", HashingEmbedder.name)

    assert noisy == plain
    # DUP-01 says "ledger" twice and scores the same as the two policies that say it once; ts_rank_cd, which counts
    # occurrences, only orders the tie.
    assert [hit.policy_id for hit in plain] == ["DUP-01", "PARTIAL-01", "EMAIL-01"]
    assert [hit.score for hit in plain] == pytest.approx([1 / 3] * 3)


async def test_tsquery_operators_and_punctuation_are_read_as_plain_text(db_session: AsyncSession) -> None:
    for query in ["!refund", "refund -partial", "a:* | b & !c <-> (d)", "O'Brien \\ C:\\temp", "?!", "日本語"]:
        hits = await keyword_ranking(db_session, query, HashingEmbedder.name)
        result = await search_policies(db_session, HashingEmbedder(), query, 5)

        # "!refund" and "-partial" are not negations: a negated term would match the policies without the word.
        assert all(hit.policy_id != "SHIP-01" for hit in hits), query
        assert result["total_policies"] == 8, query
    injection = await search_policies(db_session, HashingEmbedder(), "refund'); DROP TABLE policy_chunks; --", 5)
    assert injection["matches"] and await db_session.scalar(select(func.count()).select_from(PolicyChunk)) == 8


async def test_nonsense_query_matches_nothing_and_says_so(db_session: AsyncSession) -> None:
    result = await search_policies(db_session, HashingEmbedder(), "xyznonexistent123", 5)

    assert result == {
        "query": "xyznonexistent123",
        "matches": [],
        "total_policies": 8,
        "search": {"mode": "hybrid", "embedding_model": "hashing-v1"},
        "message": NO_MATCH_MESSAGE,
    }


async def test_max_results_keeps_the_top_of_the_ranking(db_session: AsyncSession) -> None:
    everything = await search_policies(db_session, HashingEmbedder(), "refund", 10)
    top_two = await search_policies(db_session, HashingEmbedder(), "refund", 2)

    assert len(everything["matches"]) > 2
    assert top_two["matches"] == everything["matches"][:2]


async def test_falls_back_to_ids_and_keywords_when_the_query_cannot_be_embedded(
    db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING, logger="app.search.hybrid"):
        result = await search_policies(db_session, BrokenQueryEmbedder(), "EMAIL-01 refund amount cap", 5)

    assert result["search"] == {"mode": "keyword", "embedding_model": "hashing-v1"}
    assert [match["id"] for match in result["matches"][:2]] == ["EMAIL-01", "AMOUNT-01"]
    assert all(match["similarity"] is None and "semantic" not in match["matched_by"] for match in result["matches"])
    assert "could not embed the query" in caplog.text


async def test_empty_index_tells_the_agent_to_run_the_seed(db_session: AsyncSession) -> None:
    await db_session.execute(delete(PolicyChunk))

    result = await search_policies(db_session, HashingEmbedder(), "EMAIL-01", 5)

    assert (result["matches"], result["total_policies"]) == ([], 0)
    assert result["message"] == EMPTY_INDEX_MESSAGE


async def test_excerpt_is_the_best_matching_paragraph_and_unbundled_files_stay_out(
    sessions: Sessions, corpus: Path
) -> None:
    (corpus / "other.md").write_text("# Extra\n\nPolicy OTHER-01 · v1\n\nUnlistedkeyword", encoding="utf-8")
    extra_paragraph = "Supplemental rounding example for a fractional adjustment."
    with (corpus / "03-refund-amount.md").open("a", encoding="utf-8") as source:
        source.write(f"\n{extra_paragraph}\n")
    async with sessions.begin() as session:
        await index_policies(session, HashingEmbedder(), load_corpus(corpus))

    async with sessions() as session:
        unlisted = await search_policies(session, HashingEmbedder(), "unlistedkeyword OTHER-01", 5)
        # Both AMOUNT-01 paragraphs say "fractional"; only the added one also says "supplemental".
        best = await search_policies(session, HashingEmbedder(), "supplemental fractional", 1)

    assert unlisted["matches"] == []
    [match] = best["matches"]
    assert (match["id"], match["excerpt"]) == ("AMOUNT-01", extra_paragraph)
    assert best["total_policies"] == 8


async def test_agent_calls_the_tool_through_the_registry(db_session: AsyncSession) -> None:
    context = ToolContext(db_session, datetime(2026, 11, 19, tzinfo=UTC), "UTC", HashingEmbedder())
    [email_paragraph] = next(doc for doc in load_corpus() if doc.id == "EMAIL-01").paragraphs

    found = await get_registry().dispatch("search_policies", {"query": "EMAIL-01", "max_results": 1}, context)
    invalid = await get_registry().dispatch("search_policies", {"query": "EMAIL-01", "max_results": 11}, context)

    assert isinstance(found, ToolSuccess)
    assert found.data == {
        "query": "EMAIL-01",
        "matches": [
            {
                "id": "EMAIL-01",
                "title": "Refund email drafts",
                "version": "v1",
                "file": "07-email-drafts.md",
                "excerpt": email_paragraph,
                # "EMAIL-01" is the words {-01, email}; "email" is in EMAIL-01's title: 3 of 6 points.
                "relevance_score": round(ID_MATCH_SCORE + (3 / 6) / 2, 4),
                "matched_by": ["id", "keyword"],
                "similarity": None,
            }
        ],
        "total_policies": 8,
        "search": {"mode": "hybrid", "embedding_model": "hashing-v1"},
    }
    assert isinstance(invalid, ToolFailure) and invalid.error.code == "INVALID_ARGUMENTS"


RELEVANT_QUERIES = [
    ("customer wants money back because the package arrived late", "LATE-01"),
    ("can we refund an order twice?", "DUP-01"),
    ("who needs to approve large refunds", "REVIEW-01"),
    ("what should a refund email contain", "EMAIL-01"),
]
NONSENSE_QUERIES = ["xyznonexistent123", "weather forecast for tomorrow"]
DEMO_FIRST_POLICY = [
    ("can we refund an order twice?", "DUP-01"),
    ("refund amount cap", "AMOUNT-01"),
    ("who needs to approve large refunds", "REVIEW-01"),
    ("what should a refund email contain", "EMAIL-01"),
    ("what to write in a message to the buyer", "EMAIL-01"),
    ("EMAIL-01", "EMAIL-01"),
    ("late-01 eligibility", "LATE-01"),
]
needs_model = pytest.mark.skipif(
    os.environ.get("RUN_MODEL_TESTS") != "1", reason="Set RUN_MODEL_TESTS=1 to download and run the local model"
)


async def index_with_local_model(sessions: Sessions) -> LocalEmbedder:
    """Rebuild the index with the real model, replacing the fixture's hashing vectors."""
    model = LocalEmbedder(cache_dir=settings.embedding_cache_dir)
    async with sessions.begin() as session:
        await index_policies(session, model)
    return model


@needs_model
async def test_local_model_finds_a_policy_by_meaning_alone(sessions: Sessions) -> None:
    model = await index_with_local_model(sessions)
    query = "what to write in a message to the buyer"

    async with sessions() as session:
        shared_words = await keyword_ranking(session, query, model.name)
        result = await search_policies(session, model, query, 5)
        relevant = [(await search_policies(session, model, text, 5), policy) for text, policy in RELEVANT_QUERIES]
        nonsense = [await search_policies(session, model, text, 5) for text in NONSENSE_QUERIES]

    assert shared_words == []  # Not one policy shares a word with the query.
    first = result["matches"][0]
    assert (first["id"], first["matched_by"]) == ("EMAIL-01", ["semantic"])
    assert first["similarity"] is not None and first["similarity"] >= LOCAL_MIN_SIMILARITY
    # The calibrated floor keeps the relevant policy of every required query and drops nonsense.
    for found, policy_id in relevant:
        assert any(m["id"] == policy_id and "semantic" in m["matched_by"] for m in found["matches"]), found["query"]
    assert all(found["matches"] == [] for found in nonsense)


@needs_model
async def test_local_model_ranks_the_demo_queries(sessions: Sessions) -> None:
    model = await index_with_local_model(sessions)

    async with sessions() as session:
        scenario = await search_policies(session, model, "late shipment refund", 5)
        firsts = [(await search_policies(session, model, text, 5))["matches"][0]["id"] for text, _ in DEMO_FIRST_POLICY]

    # The scenario provider's query: EXCLUDE-01's paragraph is closest in meaning, but the two policies titled
    # "Late shipment ..." cover more of the query's words, in their titles.
    top_three = [match["id"] for match in scenario["matches"][:3]]
    assert top_three[0] in {"LATE-01", "AMOUNT-01"} and {"LATE-01", "AMOUNT-01"} <= set(top_three)
    assert firsts == [policy_id for _, policy_id in DEMO_FIRST_POLICY]
