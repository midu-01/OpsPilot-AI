"""The search_policies tool: the agent-facing contract (arguments, description, result shape).

The ranking itself lives in app.search.hybrid. The result types are defined there, next to the code that fills them,
and re-exported here because they are part of this tool's contract.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from app.search.hybrid import MatchReason, PolicyMatch, PolicySearchResult, SearchMode, search_policies
from app.tools import ToolContext, ToolSpec

__all__ = ["MatchReason", "PolicyMatch", "PolicySearchResult", "SearchMode", "SearchPoliciesArgs", "execute", "spec"]


class SearchPoliciesArgs(BaseModel):
    """Search the policy documents by keyword or policy ID."""

    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)

    query: str = Field(min_length=1, max_length=500, description="Keywords or a policy ID")
    max_results: int = Field(5, ge=1, le=10, description="Maximum number of results")


async def execute(args: SearchPoliciesArgs, ctx: ToolContext) -> PolicySearchResult:
    """Return ranked citations with exact excerpts from the indexed policy paragraphs."""
    return await search_policies(ctx.session, ctx.embedder, args.query, args.max_results)


spec = ToolSpec(
    name="search_policies",
    description=(
        "Search company policies by policy ID, keywords and meaning (PostgreSQL full-text search plus pgvector "
        "similarity). Returns policy IDs, titles, versions, files, exact excerpts and why each policy matched."
    ),
    parameters_model=SearchPoliciesArgs,
    executor=execute,
    is_read_only=True,
)
