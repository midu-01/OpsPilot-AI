from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from app.tools.date_math import DateMathArgs, execute
from app.tools.query_orders import QueryOrdersArgs


@pytest.mark.parametrize(
    "arguments",
    [
        {"sql": "select 1"},
        {"sort_by": "customer_email"},
        {"status": "invalid"},
        {"limit": 101},
        {"offset": -1},
        {"offset": 2**63},
        {"min_amount_minor": True},
        {"late_only": "true"},
        {"limit": 1.5},
        {"min_amount_minor": 50, "max_amount_minor": 50},
        {"shipped_after": "2028-03-01"},
        {"shipped_after": "2028-03-01T00:00:00"},
        {"shipped_before": 0},
        {"shipped_after": "2028-03-01T00:00:00Z", "shipped_before": "2028-03-01T00:00:00+06:00"},
    ],
)
def test_invalid_query_fails_validation(arguments: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        QueryOrdersArgs.model_validate(arguments)


@pytest.mark.parametrize(
    "arguments",
    [
        {"operation": "previous_month", "sql": "select 1"},
        {"operation": "previous_month", "reference_date": "2027-02-29"},
        {"operation": "add_days", "days": True},
        {"operation": "days_between", "start_date": 0},
        {"operation": "previous_month", "reference_date": "2028-03-01T00:00:00Z"},
        {"operation": "add_days", "end_date": "2028-03-01", "days": 1},
        {"operation": "previous_month", "days": 1},
    ],
)
def test_invalid_date_arguments_fail_validation(arguments: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        DateMathArgs.model_validate(arguments)


async def test_reference_clock_respects_business_timezone() -> None:
    result = await execute(
        DateMathArgs(operation="previous_month"),
        reference_time=datetime(2028, 2, 29, 20, tzinfo=UTC),
        timezone="Asia/Dhaka",
    )
    assert result["reference_date"] == "2028-03-01"
    assert result["days_in_month"] == 29
    assert result["shipped_after"] == "2028-02-01T00:00:00+06:00"
    assert result["shipped_before"] == "2028-03-01T00:00:00+06:00"


async def test_implicit_date_requires_an_aware_clock() -> None:
    for reference in [None, datetime(2028, 3, 1)]:
        with pytest.raises(ValueError, match="aware run reference_time"):
            await execute(DateMathArgs(operation="previous_month"), reference_time=reference)


async def test_signed_days_and_overflow() -> None:
    result = await execute(
        DateMathArgs.model_validate(
            {
                "operation": "days_between",
                "start_date": "2028-03-01",
                "end_date": "2028-02-28",
            }
        )
    )
    assert result["days"] == -2
    with pytest.raises(ValueError, match="calendar range"):
        await execute(DateMathArgs.model_validate({"operation": "add_days", "reference_date": "9999-12-31", "days": 1}))
