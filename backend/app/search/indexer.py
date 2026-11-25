"""Keep the policy_chunks table in step with the bundled policy files.

index_policies() compares what is stored with what the files say now, and writes only the difference:
- a new paragraph is embedded and inserted;
- a paragraph whose text (content_sha256) or embedding model changed is embedded again and updated;
- a new title, version or file name is updated without embedding again (the vector depends on the text only);
- a paragraph that no longer exists is deleted.
A second run with the same files and model changes nothing, so the seed can run it on every start.

The seed is the only writer. Two runs at the same time could both insert a new paragraph; the second would then fail
on the unique (policy_id, chunk_index) key instead of corrupting the index.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import asdict, dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import PolicyChunk
from app.search.corpus import CorpusChunk, PolicyDocument, chunk_corpus, load_corpus
from app.search.embeddings import Embedder

type ChunkKey = tuple[str, int]


@dataclass(frozen=True)
class IndexReport:
    inserted: int
    updated: int
    unchanged: int
    deleted: int

    def __str__(self) -> str:
        return f"{self.inserted} inserted, {self.updated} updated, {self.unchanged} unchanged, {self.deleted} deleted"


def key(chunk: CorpusChunk | PolicyChunk) -> ChunkKey:
    """A paragraph's identity in the index: its policy and its position in the file."""
    return chunk.policy_id, chunk.chunk_index


def needs_embedding(row: PolicyChunk | None, chunk: CorpusChunk, model: str) -> bool:
    return row is None or row.content_sha256 != chunk.content_sha256 or row.embedding_model != model


def is_current(row: PolicyChunk, chunk: CorpusChunk) -> bool:
    """True when every column that comes from the policy file already holds the file's value."""
    return all(getattr(row, column) == value for column, value in asdict(chunk).items())


async def index_policies(
    session: AsyncSession, embedder: Embedder, documents: Sequence[PolicyDocument] | None = None
) -> IndexReport:
    """Sync the index with the policy files (or the given documents) in the caller's transaction; it never commits."""
    chunks = chunk_corpus(load_corpus() if documents is None else documents)
    stored = {key(row): row for row in await session.scalars(select(PolicyChunk))}
    wanted = {key(chunk): chunk for chunk in chunks}

    # One batch for every new or changed paragraph: the model embeds a batch much faster than one text at a time.
    to_embed = [chunk for chunk in chunks if needs_embedding(stored.get(key(chunk)), chunk, embedder.name)]
    vectors = await embedder.embed_documents([chunk.content for chunk in to_embed]) if to_embed else []
    fresh = {key(chunk): vector for chunk, vector in zip(to_embed, vectors, strict=True)}

    inserted = updated = 0
    for chunk_key, chunk in wanted.items():
        row = stored.get(chunk_key)
        if row is None:
            session.add(PolicyChunk(**asdict(chunk), embedding=fresh[chunk_key], embedding_model=embedder.name))
            inserted += 1
        elif chunk_key in fresh or not is_current(row, chunk):
            for column, value in asdict(chunk).items():
                setattr(row, column, value)
            if chunk_key in fresh:
                row.embedding, row.embedding_model = fresh[chunk_key], embedder.name
            updated += 1
    stale = [row for row_key, row in stored.items() if row_key not in wanted]
    for row in stale:
        await session.delete(row)
    await session.flush()
    return IndexReport(inserted, updated, len(wanted) - inserted - updated, len(stale))
