"""Deterministic keyword search over the bundled policy corpus."""

from __future__ import annotations

import re
from pathlib import Path
from typing import NotRequired, TypedDict

from pydantic import BaseModel, ConfigDict, Field

from app.tools import ToolSpec

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


class SearchPoliciesArgs(BaseModel):
    """Search the policy documents by keyword or policy ID."""

    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)

    query: str = Field(min_length=1, max_length=500, description="Keywords or a policy ID")
    max_results: int = Field(5, ge=1, le=10, description="Maximum number of results")


class PolicyMatch(TypedDict):
    id: str
    title: str
    version: str
    file: str
    excerpt: str
    relevance_score: int


class PolicySearchResult(TypedDict):
    query: str
    matches: list[PolicyMatch]
    total_policies: int
    message: NotRequired[str]


def _terms(text: str) -> set[str]:
    # Preserve policy IDs as single tokens, while splitting prose at punctuation.
    return set(re.findall(r"[a-z]+-\d+\b|[^\W_]+", text.casefold()))


def _match(filename: str, terms: set[str]) -> PolicyMatch | None:
    path = POLICIES_DIR / filename
    if POLICIES_DIR.is_symlink() or path.is_symlink() or not path.is_file():
        raise ValueError(f"Invalid bundled policy file: {filename}")
    sections = re.split(r"\n\s*\n", path.read_text(encoding="utf-8").strip())
    if len(sections) < 3 or not sections[0].startswith("# "):
        raise ValueError(f"Invalid policy document: {filename}")
    metadata = re.fullmatch(r"Policy ([A-Z]+-\d+) · (v\d+)(?: · .+)?", sections[1])
    if metadata is None:
        raise ValueError(f"Invalid policy metadata: {filename}")
    policy_id, version = metadata.groups()
    title = sections[0].removeprefix("# ")
    paragraphs = sections[2:]
    excerpt = max(paragraphs, key=lambda paragraph: len(terms & _terms(paragraph)))
    content_terms = _terms(" ".join((title, version, *paragraphs)))
    score = len(terms & content_terms) + len(terms & _terms(title))
    if policy_id.casefold() in terms:
        score += 1 + 2 * len(terms)  # An explicit ID outranks keyword-only hits.
    if score == 0:
        return None
    return PolicyMatch(
        id=policy_id, title=title, version=version, file=filename, excerpt=excerpt, relevance_score=score
    )


async def execute(args: SearchPoliciesArgs) -> PolicySearchResult:
    """Return ranked citations with exact excerpts from their source documents."""
    terms = _terms(args.query)
    matches = [match for filename in POLICY_FILES if (match := _match(filename, terms)) is not None]
    matches.sort(key=lambda match: (-match["relevance_score"], match["file"]))
    result = PolicySearchResult(query=args.query, matches=matches[: args.max_results], total_policies=len(POLICY_FILES))
    if not matches:
        result["message"] = "No policies matched the search terms."
    return result


spec = ToolSpec(
    name="search_policies",
    description="Search company policies by keyword or ID. Returns policy IDs, titles, versions, files and excerpts.",
    parameters_model=SearchPoliciesArgs,
    executor=lambda args, ctx: execute(args),
    is_read_only=True,
)
