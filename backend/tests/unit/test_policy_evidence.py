"""Policy citations must resolve to the exact bundled source."""

import shutil
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.tools import search_policies
from app.tools.search_policies import POLICIES_DIR, SearchPoliciesArgs, execute


@pytest.mark.parametrize(
    ("policy_id", "filename"),
    [
        ("SHIP-01", "01-shipping-commitments.md"),
        ("LATE-01", "02-late-shipment-eligibility.md"),
        ("AMOUNT-01", "03-refund-amount.md"),
        ("EXCLUDE-01", "04-exclusions.md"),
        ("PARTIAL-01", "05-partial-refunds.md"),
        ("DUP-01", "06-duplicate-requests.md"),
        ("EMAIL-01", "07-email-drafts.md"),
        ("REVIEW-01", "08-escalation.md"),
    ],
)
async def test_each_source_is_citable_by_id(policy_id: str, filename: str) -> None:
    result = await execute(SearchPoliciesArgs(query=policy_id.lower()))
    assert result["total_policies"] == 8
    (match,) = result["matches"]
    assert (match["id"], match["version"], match["file"]) == (policy_id, "v1", filename)
    source = (POLICIES_DIR / filename).read_text(encoding="utf-8")
    assert source.startswith(f"# {match['title']}\n")
    assert match["excerpt"] and match["excerpt"] in source
    assert not match["excerpt"].startswith(("#", "Policy "))


async def test_ranking_is_stable_across_repeated_terms_and_ties() -> None:
    original = await execute(SearchPoliciesArgs(query="ledger", max_results=2))
    repeated = await execute(SearchPoliciesArgs(query="LEDGER, ledger!", max_results=2))
    assert repeated["matches"] == original["matches"]
    assert [match["id"] for match in original["matches"]] == ["PARTIAL-01", "DUP-01"]


async def test_ignores_unbundled_files_and_returns_real_matching_excerpt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    corpus = tmp_path / "policies"
    shutil.copytree(POLICIES_DIR, corpus)
    (corpus / "other.md").write_text("# Extra\n\nPolicy OTHER-01 · v1\n\nUnlistedkeyword", encoding="utf-8")
    extra_paragraph = "Supplemental rounding example for a fractional adjustment."
    with (corpus / "03-refund-amount.md").open("a", encoding="utf-8") as source:
        source.write(f"\n{extra_paragraph}\n")
    monkeypatch.setattr(search_policies, "POLICIES_DIR", corpus)
    assert (await execute(SearchPoliciesArgs(query="unlistedkeyword")))["matches"] == []
    result = await execute(SearchPoliciesArgs(query="supplemental rounding", max_results=1))
    assert result["matches"][0]["excerpt"] == extra_paragraph


async def test_refuses_symlink_in_place_of_bundled_source(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    corpus = tmp_path / "policies"
    shutil.copytree(POLICIES_DIR, corpus)
    filename = "04-exclusions.md"
    (corpus / filename).rename(tmp_path / filename)
    (corpus / filename).symlink_to(tmp_path / filename)
    monkeypatch.setattr(search_policies, "POLICIES_DIR", corpus)
    with pytest.raises(ValueError, match="04-exclusions"):
        await execute(SearchPoliciesArgs(query="missing"))


@pytest.mark.parametrize(
    "arguments",
    [
        {"query": "  "},
        {"query": "x" * 501},
        {"query": "refund", "max_results": "1"},
        {"query": "refund", "max_results": True},
        {"query": "refund", "max_results": 11},
        {"query": "refund", "path": "/tmp"},
    ],
)
def test_search_parameters_are_strict(arguments: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        SearchPoliciesArgs.model_validate(arguments)
