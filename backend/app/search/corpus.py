"""The bundled policy files as data: read, validate and split them into the paragraphs the search index stores.

No database here, so the parsing rules are easy to unit-test. Every policy file has this shape, with blank lines
between the parts:

    # Late shipment refund amount
    Policy AMOUNT-01 · v1 · optional note
    First paragraph ...
    More paragraphs ...

Only the paragraphs become search chunks. The title is stored next to each chunk (the keyword index weights it
higher), and the metadata line is never quoted back as evidence.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

POLICIES_DIR = Path(__file__).resolve().parents[2] / "policies"
POLICY_FILES = (
    "01-shipping-commitments.md",
    "02-late-shipment-eligibility.md",
    "03-refund-amount.md",
    "04-exclusions.md",
    "05-partial-refunds.md",
    "06-duplicate-requests.md",
    "07-email-drafts.md",
    "08-escalation.md",
)
"""An explicit list, so a stray file dropped into the folder never becomes citable policy."""

BLANK_LINES = re.compile(r"\n\s*\n")
METADATA_LINE = re.compile(r"Policy ([A-Z]+-\d+) · (v\d+)(?: · .+)?")


@dataclass(frozen=True)
class PolicyDocument:
    id: str
    title: str
    version: str
    file: str
    paragraphs: tuple[str, ...]


@dataclass(frozen=True)
class CorpusChunk:
    """One paragraph, shaped like a policy_chunks row (named apart from the PolicyChunk table class)."""

    policy_id: str
    title: str
    version: str
    file: str
    chunk_index: int
    content: str
    content_sha256: str


def read_policy(directory: Path, filename: str) -> PolicyDocument:
    """Parse one bundled file; every ValueError names the file, so a broken policy is quick to find."""
    path = directory / filename
    # A symlink could point the index at any file on the machine, so only real files inside the folder count.
    if directory.is_symlink() or path.is_symlink() or not path.is_file():
        raise ValueError(f"Invalid bundled policy file: {filename}")
    sections = BLANK_LINES.split(path.read_text(encoding="utf-8").strip())
    if len(sections) < 3 or not sections[0].startswith("# "):
        raise ValueError(f"Invalid policy document: {filename}")
    metadata = METADATA_LINE.fullmatch(sections[1])
    if metadata is None:
        raise ValueError(f"Invalid policy metadata: {filename}")
    policy_id, version = metadata.groups()
    return PolicyDocument(policy_id, sections[0].removeprefix("# "), version, filename, tuple(sections[2:]))


def load_corpus(directory: Path = POLICIES_DIR) -> list[PolicyDocument]:
    """Read every bundled policy. IDs must be unique: the index stores one row per (policy ID, paragraph number)."""
    documents = [read_policy(directory, filename) for filename in POLICY_FILES]
    first_file: dict[str, str] = {}
    for document in documents:
        if document.id in first_file:
            raise ValueError(f"Duplicate policy ID {document.id}: {first_file[document.id]} and {document.file}")
        first_file[document.id] = document.file
    return documents


def chunk_corpus(documents: Iterable[PolicyDocument]) -> list[CorpusChunk]:
    """One chunk per paragraph: small enough to quote as evidence and to embed without truncation.

    content_sha256 fingerprints the exact text that gets embedded, so the indexer can tell when a paragraph changed.
    """
    return [
        CorpusChunk(
            policy_id=document.id,
            title=document.title,
            version=document.version,
            file=document.file,
            chunk_index=index,
            content=paragraph,
            content_sha256=hashlib.sha256(paragraph.encode()).hexdigest(),
        )
        for document in documents
        for index, paragraph in enumerate(document.paragraphs)
    ]
