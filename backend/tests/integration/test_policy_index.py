"""The indexer keeps policy_chunks in step with the policy files and embeds only what changed."""

import shutil
from collections.abc import Sequence
from datetime import date
from pathlib import Path

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app import seed
from app.models import PolicyChunk
from app.search.corpus import POLICIES_DIR, load_corpus
from app.search.embeddings import HashingEmbedder
from app.search.hybrid import EMPTY_INDEX_MESSAGE, count_policies, keyword_ranking, search_policies
from app.search.indexer import IndexReport, index_policies

type Sessions = async_sessionmaker[AsyncSession]


class RecordingEmbedder(HashingEmbedder):
    """The deterministic stand-in, optionally under another model name, recording every paragraph it embeds."""

    def __init__(self, name: str = HashingEmbedder.name) -> None:
        self.name = name
        self.embedded: list[str] = []

    async def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        self.embedded.extend(texts)
        return await super().embed_documents(texts)


@pytest.fixture
def corpus(tmp_path: Path) -> Path:
    """A writable copy of the bundled policies."""
    copy = tmp_path / "policies"
    shutil.copytree(POLICIES_DIR, copy)
    return copy


def edit(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    assert old in text
    path.write_text(text.replace(old, new), encoding="utf-8")


async def test_first_build_embeds_each_paragraph_once_and_a_rerun_writes_nothing(sessions: Sessions) -> None:
    embedder = RecordingEmbedder()
    async with sessions.begin() as session:
        await session.execute(delete(PolicyChunk))
        first = await index_policies(session, embedder)
    async with sessions.begin() as session:
        second = await index_policies(session, embedder)

    assert first == IndexReport(inserted=8, updated=0, unchanged=0, deleted=0)
    assert sorted(embedder.embedded) == sorted(paragraph for doc in load_corpus() for paragraph in doc.paragraphs)
    assert second == IndexReport(inserted=0, updated=0, unchanged=8, deleted=0)
    assert len(embedder.embedded) == 8


async def test_only_new_and_changed_paragraphs_are_embedded_and_stale_ones_are_deleted(
    sessions: Sessions, corpus: Path
) -> None:
    edit(corpus / "03-refund-amount.md", "Apply a cap of USD 100", "Apply a cap of USD 150")
    edit(corpus / "02-late-shipment-eligibility.md", "# Late shipment eligibility", "# Late shipment entitlement")
    extra = "Record who approved the exception and when."
    with (corpus / "08-escalation.md").open("a", encoding="utf-8") as source:
        source.write(f"\n{extra}\n")
    [original_amount] = next(doc for doc in load_corpus() if doc.id == "AMOUNT-01").paragraphs
    [changed_amount] = next(doc for doc in load_corpus(corpus) if doc.id == "AMOUNT-01").paragraphs
    embedder = RecordingEmbedder()

    async with sessions.begin() as session:
        edited = await index_policies(session, embedder, load_corpus(corpus))
    async with sessions() as session:
        renamed = await keyword_ranking(session, "entitlement", embedder.name)
    async with sessions.begin() as session:
        restored = await index_policies(session, embedder)

    # A new title alone is an update without embedding again: the vector depends on the paragraph text only.
    assert edited == IndexReport(inserted=1, updated=2, unchanged=6, deleted=0)
    assert sorted(embedder.embedded[:2]) == sorted([extra, changed_amount])
    # PostgreSQL regenerates search_vector on update, so the new title is searchable at once.
    assert [hit.policy_id for hit in renamed] == ["LATE-01"]
    assert restored == IndexReport(inserted=0, updated=2, unchanged=6, deleted=1)
    assert embedder.embedded[2:] == [original_amount]


async def test_switching_models_embeds_everything_again_and_scopes_search_to_that_model(sessions: Sessions) -> None:
    newer = RecordingEmbedder("hashing-v2")
    async with sessions.begin() as session:
        report = await index_policies(session, newer)
    async with sessions() as session:
        models = set(await session.scalars(select(PolicyChunk.embedding_model)))
        stale_model = await search_policies(session, HashingEmbedder(), "refund", 5)
        current_model = await search_policies(session, newer, "refund", 5)

    assert report == IndexReport(inserted=0, updated=8, unchanged=0, deleted=0)
    assert len(newer.embedded) == 8 and models == {"hashing-v2"}
    # Vectors from different models are never compared: for the old model the index is empty.
    assert (stale_model["total_policies"], stale_model["matches"]) == (0, [])
    assert stale_model["message"] == EMPTY_INDEX_MESSAGE
    assert current_model["total_policies"] == 8 and current_model["matches"]


async def test_seed_builds_the_policy_index_and_prints_its_report(
    sessions: Sessions, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async with sessions.begin() as session:
        await session.execute(delete(PolicyChunk))
    monkeypatch.setattr(seed, "async_session_factory", sessions)
    monkeypatch.setattr(seed, "engine", sessions.kw["bind"])  # initialize() disposes the engine it used.

    await seed.initialize(date(2026, 2, 15))

    assert "Policy index (hashing-v1): 8 inserted, 0 updated, 0 unchanged, 0 deleted." in capsys.readouterr().out
    async with sessions() as session:
        assert await count_policies(session, HashingEmbedder.name) == 8
