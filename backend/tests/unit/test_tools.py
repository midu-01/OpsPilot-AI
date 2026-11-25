"""Unit tests for the four typed tools and the tool registry."""

from datetime import UTC, date, datetime

import pytest
from pydantic import ValidationError

from app.tools.date_math import DateMathArgs, previous_month
from app.tools.date_math import execute as date_math_execute
from app.tools.issue_refund import REFUND_CAP_MINOR, calculate_refund_amount
from app.tools.registry import get_registry
from app.tools.search_policies import SearchPoliciesArgs

registry = get_registry()


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


def test_registry_has_four_tools() -> None:
    assert set(registry.names) == {"query_orders", "search_policies", "date_math", "issue_refund"}


def test_registry_definitions_include_schemas() -> None:
    defs = registry.definitions()
    assert len(defs) == 4
    names = {d.name for d in defs}
    assert "query_orders" in names
    refund = next(d for d in defs if d.name == "issue_refund")
    assert refund.requires_approval is True


def test_registry_rejects_unknown_tool() -> None:
    with pytest.raises(KeyError, match="Unknown tool"):
        registry.validate_arguments("nonexistent_tool", {})


def test_registry_validates_arguments() -> None:
    args = registry.validate_arguments("date_math", {"operation": "previous_month"})
    assert isinstance(args, DateMathArgs)


def test_registry_rejects_invalid_arguments() -> None:
    with pytest.raises(ValidationError):
        registry.validate_arguments("query_orders", {"limit": 0})


# ---------------------------------------------------------------------------
# date_math
# ---------------------------------------------------------------------------


def test_previous_month_is_calendar_month() -> None:
    assert previous_month(date(2026, 11, 19)) == (date(2026, 10, 1), date(2026, 11, 1))


def test_previous_month_january_wraps_to_december() -> None:
    assert previous_month(date(2027, 1, 1)) == (date(2026, 12, 1), date(2027, 1, 1))


def test_previous_month_march_handles_february() -> None:
    start, end = previous_month(date(2028, 3, 15))
    assert start == date(2028, 2, 1)
    assert end == date(2028, 3, 1)


def test_previous_month_leap_year() -> None:
    start, end = previous_month(date(2028, 3, 1))
    assert start == date(2028, 2, 1)
    assert end == date(2028, 3, 1)


async def test_date_math_previous_month_operation() -> None:
    ref = datetime(2026, 11, 19, tzinfo=UTC)
    result = await date_math_execute(
        DateMathArgs(operation="previous_month"),
        reference_time=ref,
    )
    assert result["start"] == "2026-10-01"
    assert result["end"] == "2026-11-01"
    assert result["start_inclusive"] is True
    assert result["end_exclusive"] is True
    assert result["days_in_month"] == 31


async def test_date_math_days_between() -> None:
    result = await date_math_execute(
        DateMathArgs(operation="days_between", start_date="2026-11-01", end_date="2026-11-19")
    )
    assert result["days"] == 18


async def test_date_math_add_days() -> None:
    result = await date_math_execute(DateMathArgs(operation="add_days", reference_date="2026-11-19", days=-30))
    assert result["result"] == "2026-10-20"


@pytest.mark.parametrize("operation", ["days_between", "add_days"])
def test_date_math_missing_params(operation: str) -> None:
    with pytest.raises(ValidationError):
        DateMathArgs.model_validate({"operation": operation})


# ---------------------------------------------------------------------------
# search_policies
# ---------------------------------------------------------------------------


# Ranking needs the pgvector index: see tests/integration/test_policy_search.py.
@pytest.mark.parametrize(
    "arguments",
    [
        {"query": "  "},
        {"query": "x" * 501},
        {"query": "refund", "max_results": "1"},
        {"query": "refund", "max_results": True},
        {"query": "refund", "max_results": 0},
        {"query": "refund", "max_results": 11},
        {"query": "refund", "path": "/tmp"},
    ],
)
def test_search_parameters_are_strict(arguments: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        SearchPoliciesArgs.model_validate(arguments)


def test_search_arguments_strip_the_query_and_default_to_five_results() -> None:
    args = SearchPoliciesArgs.model_validate({"query": "  late shipment refund  "})

    assert (args.query, args.max_results) == ("late shipment refund", 5)


def test_search_tool_describes_hybrid_search_to_the_model() -> None:
    [definition] = [item for item in registry.definitions() if item.name == "search_policies"]

    assert "pgvector" in definition.description and "why each policy matched" in definition.description
    assert definition.requires_approval is False


# ---------------------------------------------------------------------------
# issue_refund — calculation logic (no DB needed)
# ---------------------------------------------------------------------------


def test_refund_10_percent_of_order() -> None:
    # $625.00 order → 10% = $62.50
    assert calculate_refund_amount(62500, 0) == 6250


def test_refund_capped_at_100_dollars() -> None:
    # $2000.00 order → 10% = $200 → capped at $100
    assert calculate_refund_amount(200000, 0) == REFUND_CAP_MINOR


def test_refund_exactly_500_threshold() -> None:
    # $500.00 order → 10% = $50.00
    assert calculate_refund_amount(50000, 0) == 5000


def test_refund_half_cent_rounds_up() -> None:
    # $845.05 → 10% = $84.505 → rounds up to $84.51 (8451 cents)
    assert calculate_refund_amount(84505, 0) == 8451


def test_refund_limited_by_remaining_balance() -> None:
    # $625.00 order, $60000 already refunded → remaining $25.00
    # 10% = $62.50 but only $25.00 available
    assert calculate_refund_amount(62500, 60000) == 2500


def test_refund_zero_when_fully_refunded() -> None:
    assert calculate_refund_amount(62500, 62500) == 0


def test_refund_zero_when_over_refunded() -> None:
    assert calculate_refund_amount(62500, 70000) == 0


def test_refund_exact_cap_boundary() -> None:
    # $1000.00 → 10% = $100.00 = exactly the cap
    assert calculate_refund_amount(100000, 0) == REFUND_CAP_MINOR


def test_refund_just_under_cap() -> None:
    # $999.99 → 10% = $99.999 → rounds up to $100.00 = cap
    assert calculate_refund_amount(99999, 0) == REFUND_CAP_MINOR


def test_refund_just_over_cap() -> None:
    # $1000.01 → 10% = $100.001 → rounds to $100.00 → capped at $100
    assert calculate_refund_amount(100001, 0) == REFUND_CAP_MINOR
