"""The embedders turn text into the 384-number vectors stored in policy_chunks.embedding.

HashingEmbedder is the deterministic stand-in every other test relies on, so its geometry is pinned here.
LocalEmbedder is tested against a fake fastembed module (no download); the real model only runs when
RUN_MODEL_TESTS=1.
"""

import asyncio
import math
import os
import sys
import threading
import time
from collections.abc import Iterable, Iterator
from types import ModuleType

import numpy as np
import pytest

from app.config import settings
from app.search.embeddings import (
    EMBEDDING_DIMENSIONS,
    HASHING_MIN_SIMILARITY,
    LOCAL_MIN_SIMILARITY,
    LOCAL_MODEL_NAME,
    HashingEmbedder,
    LocalEmbedder,
    get_embedder,
)

# Real paragraphs from policies/03-refund-amount.md, 05-partial-refunds.md and 07-email-drafts.md.
AMOUNT_PARAGRAPH = (
    "Calculate 10% of the order amount. Round a fractional cent to the nearest cent, with half cents rounded up. "
    "Apply a cap of USD 100 and never exceed the remaining refundable balance. For example, an eligible $845.05 "
    "order with its full balance available qualifies for $84.51."
)
PARTIAL_PARAGRAPH = (
    "Subtract prior refunds from the original order total to find the remaining balance. An unrelated partial "
    "refund reduces the balance. If the same late-shipment adjustment was already issued, apply the "
    "duplicate-request policy. Escalate a partially refunded record when its ledger history is incomplete."
)
EMAIL_PARAGRAPH = (
    "Address the fictional customer by name, identify the order, acknowledge the delay, and explain the policy in "
    "plain language. Describe an unapproved amount as proposed. Describe a refund as issued only after a ledger "
    "entry confirms it. A request to draft an email authorizes the draft alone."
)


def cosine(left: list[float], right: list[float]) -> float:
    """Both vectors have unit length, so their dot product is the cosine similarity pgvector computes."""
    return sum(a * b for a, b in zip(left, right, strict=True))


async def test_hashing_embedder_is_deterministic_and_ignores_case() -> None:
    text = "Late shipment refunds follow LATE-01."
    first = await HashingEmbedder().embed_query(text)
    shouted = await HashingEmbedder().embed_query(text.upper())
    [as_document] = await HashingEmbedder().embed_documents([text])

    assert first == shouted == as_document


async def test_hashing_vectors_have_384_dimensions_and_unit_length() -> None:
    vectors = await HashingEmbedder().embed_documents(["refund amount cap", AMOUNT_PARAGRAPH, "LATE-01"])

    assert len(vectors) == 3
    for vector in vectors:
        assert len(vector) == EMBEDDING_DIMENSIONS
        assert math.isclose(math.hypot(*vector), 1.0, rel_tol=1e-9)


@pytest.mark.parametrize("text", ["", "   ", "?!", "___", "— · —"])
async def test_text_without_words_embeds_to_the_zero_vector(text: str) -> None:
    assert await HashingEmbedder().embed_query(text) == [0.0] * EMBEDDING_DIMENSIONS


async def test_word_order_matters_through_bigrams() -> None:
    embedder = HashingEmbedder()
    forward = await embedder.embed_query("refund amount")
    reversed_order = await embedder.embed_query("amount refund")

    assert cosine(forward, reversed_order) < 0.99


async def test_related_text_is_closer_than_unrelated_text() -> None:
    embedder = HashingEmbedder()
    query = await embedder.embed_query("partial refund remaining balance")
    related, unrelated = await embedder.embed_documents([PARTIAL_PARAGRAPH, EMAIL_PARAGRAPH])

    assert cosine(query, related) > cosine(query, unrelated)


@pytest.mark.parametrize(
    ("query", "related", "unrelated"),
    [
        ("partial refund remaining balance", PARTIAL_PARAGRAPH, EMAIL_PARAGRAPH),
        ("refund email draft", EMAIL_PARAGRAPH, PARTIAL_PARAGRAPH),
    ],
)
async def test_min_similarity_keeps_related_paragraphs_and_drops_unrelated_ones(
    query: str, related: str, unrelated: str
) -> None:
    embedder = HashingEmbedder()
    query_vector = await embedder.embed_query(query)
    related_vector, unrelated_vector = await embedder.embed_documents([related, unrelated])

    assert embedder.min_similarity == HASHING_MIN_SIMILARITY
    assert cosine(query_vector, related_vector) >= embedder.min_similarity > cosine(query_vector, unrelated_vector)


async def test_nonsense_query_stays_below_min_similarity() -> None:
    embedder = HashingEmbedder()
    query = await embedder.embed_query("xyznonexistent123")
    paragraphs = await embedder.embed_documents([AMOUNT_PARAGRAPH, PARTIAL_PARAGRAPH, EMAIL_PARAGRAPH])

    assert all(cosine(query, paragraph) < embedder.min_similarity for paragraph in paragraphs)


@pytest.fixture
def fresh_embedder_cache() -> Iterator[None]:
    """get_embedder() caches one instance per process; tests that change settings need a clean cache."""
    get_embedder.cache_clear()
    yield
    get_embedder.cache_clear()


def test_get_embedder_returns_one_shared_hashing_embedder_in_tests(fresh_embedder_cache: None) -> None:
    embedder = get_embedder()

    assert isinstance(embedder, HashingEmbedder)
    assert get_embedder() is embedder


def test_get_embedder_builds_a_local_embedder_without_loading_the_model(
    monkeypatch: pytest.MonkeyPatch, fresh_embedder_cache: None
) -> None:
    monkeypatch.setattr(settings, "embedding_provider", "local")
    # A None entry makes any `import fastembed` fail, which proves nothing is loaded at construction time.
    monkeypatch.setitem(sys.modules, "fastembed", None)

    embedder = get_embedder()

    assert isinstance(embedder, LocalEmbedder)
    assert embedder.name == LOCAL_MODEL_NAME == "BAAI/bge-small-en-v1.5"
    assert embedder.min_similarity == LOCAL_MIN_SIMILARITY


class FakeTextEmbedding:
    """Stands in for fastembed.TextEmbedding: records how it was built and which thread ran inference."""

    instances: list["FakeTextEmbedding"] = []
    embedding_size = EMBEDDING_DIMENSIONS

    def __init__(self, model_name: str, cache_dir: str | None = None) -> None:
        time.sleep(0.05)  # A slow load widens the window in which racing threads could each build a model.
        self.model_name = model_name
        self.cache_dir = cache_dir
        self.calls: list[tuple[str, list[str], bool]] = []
        FakeTextEmbedding.instances.append(self)

    def _vectors(self, kind: str, texts: list[str]) -> Iterator[np.ndarray]:
        self.calls.append((kind, texts, threading.current_thread() is threading.main_thread()))
        for text in texts:
            vector = np.zeros(self.embedding_size, dtype=np.float32)
            vector[len(text) % self.embedding_size] = 1.0
            yield vector

    def passage_embed(self, texts: Iterable[str]) -> Iterator[np.ndarray]:
        return self._vectors("passage", list(texts))

    def query_embed(self, query: str) -> Iterator[np.ndarray]:
        return self._vectors("query", [query])


@pytest.fixture
def fake_fastembed(monkeypatch: pytest.MonkeyPatch) -> type[FakeTextEmbedding]:
    module = ModuleType("fastembed")
    module.TextEmbedding = FakeTextEmbedding  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "fastembed", module)
    monkeypatch.setattr(FakeTextEmbedding, "instances", [])
    return FakeTextEmbedding


async def test_local_embedder_loads_once_and_embeds_off_the_event_loop(
    fake_fastembed: type[FakeTextEmbedding],
) -> None:
    embedder = LocalEmbedder(cache_dir="/models")

    queries = await asyncio.gather(*(embedder.embed_query("late refund") for _ in range(4)))
    documents = await embedder.embed_documents(["a", "bb"])

    [model] = fake_fastembed.instances
    assert (model.model_name, model.cache_dir) == (LOCAL_MODEL_NAME, "/models")
    assert all(isinstance(value, float) for value in queries[0])
    assert queries[0][len("late refund")] == 1.0 and len(queries[0]) == EMBEDDING_DIMENSIONS
    assert documents[0][1] == 1.0 and documents[1][2] == 1.0
    assert ("passage", ["a", "bb"], False) in model.calls
    assert all(not on_main_thread for _, _, on_main_thread in model.calls)


async def test_local_embedder_rejects_a_model_with_another_vector_size(
    fake_fastembed: type[FakeTextEmbedding], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(fake_fastembed, "embedding_size", 768)

    with pytest.raises(ValueError, match="768"):
        await LocalEmbedder().embed_query("refund")


@pytest.mark.skipif(
    os.environ.get("RUN_MODEL_TESTS") != "1", reason="Set RUN_MODEL_TESTS=1 to download and run the local model"
)
async def test_local_model_matches_meaning_without_shared_keywords() -> None:
    embedder = LocalEmbedder(cache_dir=settings.embedding_cache_dir)
    query = await embedder.embed_query("How much money does a customer get back, at most?")
    related, unrelated = await embedder.embed_documents([AMOUNT_PARAGRAPH, EMAIL_PARAGRAPH])

    assert len(query) == EMBEDDING_DIMENSIONS
    assert math.isclose(math.hypot(*query), 1.0, rel_tol=1e-4)
    assert cosine(query, related) > cosine(query, unrelated)
