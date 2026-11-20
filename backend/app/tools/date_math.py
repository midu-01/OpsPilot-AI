"""Calendar and date arithmetic using a run's reference clock and business timezone."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Literal, Self
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, JsonValue, field_validator, model_validator

from app.seed import previous_month as previous_month
from app.tools import InvalidToolArguments, ToolSpec


def days_between(start: date, end: date) -> int:
    """Signed number of days from start to end."""
    return (end - start).days


class DateMathArgs(BaseModel):
    """Calendar dates use YYYY-MM-DD. Signed day counts support subtraction."""

    model_config = ConfigDict(extra="forbid", strict=True)

    operation: Literal["previous_month", "days_between", "add_days"]
    reference_date: date | None = Field(None, description="Defaults to the run date in the business timezone")
    start_date: date | None = Field(None, description="Starting date for days_between")
    end_date: date | None = Field(None, description="Ending date for days_between")
    days: int | None = Field(None, description="Number of calendar days for add_days")

    @field_validator("reference_date", "start_date", "end_date", mode="before")
    @classmethod
    def parse_iso_date(cls, value: object) -> object:
        if isinstance(value, str):
            parsed = date.fromisoformat(value)
            if parsed.isoformat() != value:
                raise ValueError("Use a calendar date in YYYY-MM-DD format")
            return parsed
        return value

    @model_validator(mode="after")
    def validate_operation(self) -> Self:
        if self.operation == "days_between":
            if self.start_date is None or self.end_date is None:
                raise ValueError("days_between requires start_date and end_date")
            if self.reference_date is not None or self.days is not None:
                raise ValueError("days_between only accepts start_date and end_date")
        elif self.start_date is not None or self.end_date is not None:
            raise ValueError("start_date and end_date are only valid for days_between")
        elif self.operation == "add_days" and self.days is None:
            raise ValueError("add_days requires days")
        elif self.operation == "previous_month" and self.days is not None:
            raise ValueError("days is only valid for add_days")
        return self


async def execute(
    args: DateMathArgs, *, reference_time: datetime | None = None, timezone: str = "UTC"
) -> dict[str, JsonValue]:
    """Resolve local calendar dates, including offset-aware bounds usable by query_orders."""
    if args.operation == "days_between":
        assert args.start_date is not None and args.end_date is not None  # Validated together.
        return {
            "operation": args.operation,
            "start_date": args.start_date.isoformat(),
            "end_date": args.end_date.isoformat(),
            "days": days_between(args.start_date, args.end_date),
        }

    zone = ZoneInfo(timezone)
    ref = args.reference_date
    if ref is None:
        if reference_time is None or reference_time.utcoffset() is None:
            raise ValueError("Supply an aware run reference_time or an explicit reference_date")
        ref = reference_time.astimezone(zone).date()

    try:
        if args.operation == "add_days":
            assert args.days is not None  # Validated for add_days.
            result = ref + timedelta(days=args.days)
            return {
                "operation": args.operation,
                "reference_date": ref.isoformat(),
                "days": args.days,
                "result": result.isoformat(),
            }
        start, end = previous_month(ref)
    except OverflowError as exc:
        raise InvalidToolArguments("Result falls outside the supported calendar range") from exc
    return {
        "operation": args.operation,
        "reference_date": ref.isoformat(),
        "start": start.isoformat(),
        "end": end.isoformat(),
        "start_inclusive": True,
        "end_exclusive": True,
        "days_in_month": days_between(start, end),
        "shipped_after": datetime.combine(start, time.min, tzinfo=zone).isoformat(),
        "shipped_before": datetime.combine(end, time.min, tzinfo=zone).isoformat(),
    }


spec = ToolSpec(
    name="date_math",
    description=(
        "Find the previous calendar month in the run's business timezone, count days between dates, "
        "or add/subtract days. Use the previous month's shipped_after and shipped_before with query_orders."
    ),
    parameters_model=DateMathArgs,
    executor=lambda args, ctx: execute(args, reference_time=ctx.reference_time, timezone=ctx.timezone),
    is_read_only=True,
)
