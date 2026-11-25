"""Turn text into 384-number vectors so PostgreSQL (pgvector) can compare policies by meaning.

Two embedders share one small interface:

- LocalEmbedder runs BAAI/bge-small-en-v1.5 through fastembed (ONNX Runtime on the CPU) inside the backend process:
  no API key, no network call per query, and the same model embeds the documents and the queries.
- HashingEmbedder is the deterministic stand-in for tests (EMBEDDING_PROVIDER=hashing): no download and the same
  vectors on every machine. It only sees shared words, so it proves the plumbing, not the semantics.

Every stored vector records `Embedder.name`, so switching models re-embeds the corpus instead of comparing vectors
that two different models produced.
"""

from __future__ import annotations

import asyncio
import functools
import hashlib
import math
import re
import threading
from collections.abc import Sequence
from itertools import pairwise
from typing import TYPE_CHECKING, Protocol

from app.config import settings

if TYPE_CHECKING:
    from fastembed import TextEmbedding

EMBEDDING_DIMENSIONS = 384
"""Vector length of both embedders; the policy_chunks.embedding column is declared with it."""

LOCAL_MODEL_NAME = "BAAI/bge-small-en-v1.5"
LOCAL_MIN_SIMILARITY = 0.6
"""Calibrated with the real model against the 8 policy paragraphs:

- relevant queries reach their policy: "can we refund an order twice?" DUP-01 0.77, "what should a refund email
  contain" EMAIL-01 0.75, "who needs to approve large refunds" REVIEW-01 0.74, "customer wants money back because
  the package arrived late" LATE-01 0.67; paraphrases sharing no word with their policy score 0.61-0.71;
- nonsense stays below: "xyznonexistent123" peaks at 0.59, "weather forecast for tomorrow" at 0.46, and 50 other
  off-topic or garbage queries at 0.32-0.58.
bge-small squeezes all scores into about 0.3-0.8, and most policies clear 0.6 for any on-topic query, so this floor
only separates on-topic from off-topic queries; the fused ranking decides the order.
"""

HASHING_MIN_SIMILARITY = 0.2
"""About four standard deviations of chance similarity (1/sqrt(384) is about 0.05), measured on the 8 policies:

- a query sharing two or more words and a word pair with a paragraph scores 0.22-0.27 and passes
  ("partial refund remaining balance" vs PARTIAL-01: 0.245);
- a single shared word in a long paragraph scores 0.06-0.13, as low as chance, so keyword ranking handles it;
- 1.1 % of random 1-4 word queries reach 0.2 on one of the 8 paragraphs (4.6 % at 0.15).
"""

TOKEN_PATTERN = re.compile(r"[a-z]+-\d+\b|[^\W_]+")


class Embedder(Protocol):
    """What the indexer and the search need from an embedding model."""

    name: str
    """Stored with every vector, so vectors from different models are never compared."""
    min_similarity: float
    """Cosine similarity below this does not count as a semantic match."""

    async def embed_documents(self, texts: Sequence[str]) -> list[list[float]]: ...

    async def embed_query(self, text: str) -> list[float]: ...


def unit_length(values: list[float]) -> list[float]:
    """Scale to length 1 so cosine similarity is a plain dot product; the zero vector stays zero."""
    norm = math.sqrt(sum(value * value for value in values))
    return [value / norm for value in values] if norm else values


class HashingEmbedder:
    """The hashing trick: every word and pair of adjacent words adds +1 or -1 to one of 384 buckets."""

    name = "hashing-v1"
    min_similarity = HASHING_MIN_SIMILARITY

    @staticmethod
    def features(text: str) -> list[str]:
        """Casefolded words (policy IDs such as late-01 stay whole) plus adjacent pairs, which capture word order."""
        words = TOKEN_PATTERN.findall(text.casefold())
        return words + [f"{first} {second}" for first, second in pairwise(words)]

    def vector(self, text: str) -> list[float]:
        values = [0.0] * EMBEDDING_DIMENSIONS
        for feature in self.features(text):
            # blake2b rather than hash(): Python salts hash() per process, which would change vectors between runs.
            digest = int.from_bytes(hashlib.blake2b(feature.encode(), digest_size=8).digest(), "big")
            # The hash picks the bucket and its top bit picks the sign, so unrelated words that land in the same
            # bucket tend to cancel out instead of looking alike.
            values[digest % EMBEDDING_DIMENSIONS] += 1.0 if digest >> 63 else -1.0
        return unit_length(values)

    async def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        return [self.vector(text) for text in texts]

    async def embed_query(self, text: str) -> list[float]:
        return self.vector(text)


class LocalEmbedder:
    """BAAI/bge-small-en-v1.5 (384 dimensions, about 67 MB) through fastembed, loaded on first use."""

    name = LOCAL_MODEL_NAME
    min_similarity = LOCAL_MIN_SIMILARITY

    def __init__(self, cache_dir: str | None = None) -> None:
        self.cache_dir = cache_dir
        self._model: TextEmbedding | None = None
        self._lock = threading.Lock()

    def _load(self) -> TextEmbedding:
        # Inference runs in worker threads, so two first requests can race here; the lock loads the model once.
        with self._lock:
            if self._model is None:
                import fastembed  # Imported on first use, so tests and migrations never load ONNX Runtime.

                model = fastembed.TextEmbedding(LOCAL_MODEL_NAME, cache_dir=self.cache_dir)
                if model.embedding_size != EMBEDDING_DIMENSIONS:
                    raise ValueError(
                        f"{LOCAL_MODEL_NAME} returns {model.embedding_size} numbers per text; "
                        f"the policy index stores {EMBEDDING_DIMENSIONS}"
                    )
                self._model = model
            return self._model

    def _embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [[float(value) for value in vector] for vector in self._load().passage_embed(texts)]

    def _embed_query(self, text: str) -> list[float]:
        [vector] = self._load().query_embed(text)
        return [float(value) for value in vector]

    async def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        # Inference is CPU-bound: a worker thread keeps the event loop free to serve streams meanwhile.
        return await asyncio.to_thread(self._embed_documents, list(texts))

    async def embed_query(self, text: str) -> list[float]:
        return await asyncio.to_thread(self._embed_query, text)


@functools.cache
def get_embedder() -> Embedder:
    """One embedder per process, so the local model is loaded once and shared by every run."""
    if settings.embedding_provider == "hashing":
        return HashingEmbedder()
    return LocalEmbedder(cache_dir=settings.embedding_cache_dir)
