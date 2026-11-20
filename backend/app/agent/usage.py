"""Aggregate provider-reported counts and Decimal cost estimates for a model attempt."""

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal, DecimalException

from pydantic import JsonValue

from app.agent.contracts import ModelEvent, ModelEventType
from app.models import ModelCall, Run

MILLION = Decimal(1_000_000)
USD_QUANTUM = Decimal("0.0000000001")  # runs and model_calls both use NUMERIC(20, 10).
MAX_USD = Decimal("9999999999.9999999999")
MAX_COUNT = 2**31 - 1


@dataclass(frozen=True)
class Pricing:
    """Model-specific USD rates per million tokens from configuration."""

    input_usd: Decimal
    output_usd: Decimal
    cached_input_usd: Decimal

    def __post_init__(self) -> None:
        for rate in (self.input_usd, self.output_usd, self.cached_input_usd):
            if not isinstance(rate, Decimal) or not rate.is_finite() or rate < 0:
                raise ValueError("Token pricing must use finite nonnegative Decimal rates")

    def snapshot(self) -> dict[str, JsonValue]:
        return {
            "unit": "USD per million tokens",
            "input_usd": str(self.input_usd),
            "output_usd": str(self.output_usd),
            "cached_input_usd": str(self.cached_input_usd),
        }

    def estimate(self, inputs: int | None, outputs: int | None, cached: int | None) -> Decimal | None:
        if inputs is None or outputs is None:
            return None
        if cached is None:
            # With an unreported cache split, use the higher rate for a list-price ceiling.
            cached = inputs if self.cached_input_usd > self.input_usd else 0
        try:
            cost = (inputs - cached) * self.input_usd + cached * self.cached_input_usd + outputs * self.output_usd
            return (cost / MILLION).quantize(USD_QUANTUM, rounding=ROUND_HALF_UP)
        except DecimalException as error:
            raise ValueError("Estimated cost exceeds supported precision") from error


def record_usage(run: Run, call: ModelCall, event: ModelEvent | None, pricing: Pricing | None) -> None:
    """Finalize usage once per attempt, in the caller's locked run transaction.

    total_tokens accumulates known tokens. Completeness is sticky across attempts
    so a later successful call cannot turn a partial run into a fully priced run.
    """
    if event is not None and event.type != ModelEventType.usage:
        raise ValueError("Expected a usage event")
    inputs = event.input_tokens if event else None
    outputs = event.output_tokens if event else None
    cached = event.cached_tokens if event else None
    for count in (inputs, outputs, cached):
        if count is not None and (type(count) is not int or not 0 <= count <= MAX_COUNT):
            raise ValueError("Token count must fit a nonnegative PostgreSQL integer")
    if inputs is not None and cached is not None and cached > inputs:
        raise ValueError("Cached tokens cannot exceed input tokens")

    cursor = run.execution_cursor or {}
    total_tokens_known = inputs is not None and outputs is not None
    cost = pricing.estimate(inputs, outputs, cached) if pricing is not None else None
    run_cost = None
    if cost is not None and cursor.get("cost_complete", True):
        run_cost = (run.estimated_cost_usd or Decimal(0)) + cost
    if (cost is not None and cost > MAX_USD) or (run_cost is not None and run_cost > MAX_USD):
        raise ValueError("Estimated cost exceeds supported precision")

    call.input_tokens = inputs
    call.output_tokens = outputs
    call.cached_tokens = cached
    call.pricing_snapshot = pricing.snapshot() if pricing is not None else None
    upper_bound = bool(
        pricing and inputs and cached is None and cost is not None and pricing.input_usd != pricing.cached_input_usd
    )
    if upper_bound and call.pricing_snapshot is not None:
        call.pricing_snapshot["basis"] = "upper_bound"
    call.estimated_cost_usd = cost
    call.usage_complete = total_tokens_known and cached is not None
    # If only cached input is reported, it still contributes a known lower bound.
    known_inputs = inputs if inputs is not None else (cached or 0)
    run.total_tokens = (run.total_tokens or 0) + known_inputs + (outputs or 0)
    run.estimated_cost_usd = run_cost
    run.execution_cursor = {
        **cursor,
        "token_usage_complete": cursor.get("token_usage_complete", True) is True and total_tokens_known,
        "cost_complete": run_cost is not None,
    }
    if upper_bound:
        run.execution_cursor["cost_upper_bound"] = True
