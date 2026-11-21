from decimal import Decimal

import pytest

from app.agent.contracts import ModelEvent, ModelEventType
from app.agent.usage import Pricing, record_usage
from app.models import ModelCall, Run

RATES = Pricing(Decimal("2"), Decimal("4"), Decimal("0.50"))


def usage(inputs: int | None, outputs: int | None, cached: int | None) -> ModelEvent:
    return ModelEvent(type=ModelEventType.usage, input_tokens=inputs, output_tokens=outputs, cached_tokens=cached)


def test_cached_input_is_a_subset_and_prices_are_snapshotted_per_call() -> None:
    run = Run(execution_cursor={"position": 4})
    first, second = ModelCall(), ModelCall()
    record_usage(run, first, usage(100, 20, 30), RATES)
    record_usage(run, second, usage(25, 10, 25), Pricing(Decimal("3"), Decimal("6"), Decimal("1")))
    assert first.usage_complete and second.usage_complete
    assert (first.input_tokens, first.output_tokens, first.cached_tokens) == (100, 20, 30)
    assert first.estimated_cost_usd == Decimal("0.000235")
    assert first.pricing_snapshot == {
        "unit": "USD per million tokens",
        "input_usd": "2",
        "output_usd": "4",
        "cached_input_usd": "0.50",
    }
    assert second.estimated_cost_usd == Decimal("0.000085")
    assert run.estimated_cost_usd == Decimal("0.000320")
    assert run.total_tokens == 155
    assert run.execution_cursor == {"position": 4, "token_usage_complete": True, "cost_complete": True}


def test_missing_usage_stays_unknown_across_later_priced_calls() -> None:
    run, missing = Run(total_tokens=15, estimated_cost_usd=Decimal("0.01")), ModelCall()
    record_usage(run, missing, None, RATES)
    assert (missing.input_tokens, missing.output_tokens, missing.cached_tokens) == (None, None, None)
    assert missing.pricing_snapshot is not None
    assert missing.estimated_cost_usd is None and not missing.usage_complete
    record_usage(run, ModelCall(), usage(5, 4, 1), RATES)
    assert run.total_tokens == 24
    assert run.estimated_cost_usd is None
    assert run.execution_cursor == {"token_usage_complete": False, "cost_complete": False}


@pytest.mark.parametrize(
    ("inputs", "outputs", "cached", "subtotal", "complete_total"),
    [
        (None, 4, 3, 7, False),
        (8, None, 3, 8, False),
        (8, 4, None, 12, True),
    ],
)
def test_partial_usage_preserves_each_known_count(
    inputs: int | None, outputs: int | None, cached: int | None, subtotal: int, complete_total: bool
) -> None:
    run, call = Run(), ModelCall()
    record_usage(run, call, usage(inputs, outputs, cached), RATES)
    assert (call.input_tokens, call.output_tokens, call.cached_tokens) == (inputs, outputs, cached)
    assert run.total_tokens == subtotal
    assert not call.usage_complete
    assert run.execution_cursor["token_usage_complete"] is complete_total
    if complete_total:
        assert call.estimated_cost_usd == run.estimated_cost_usd == Decimal("0.000032")
        assert call.pricing_snapshot and call.pricing_snapshot["basis"] == "upper_bound"
        assert run.execution_cursor["cost_upper_bound"] is True
    else:
        assert call.estimated_cost_usd is None and run.estimated_cost_usd is None


def test_complete_counts_without_pricing_do_not_create_a_zero_cost() -> None:
    run, call = Run(), ModelCall()
    record_usage(run, call, usage(0, 0, 0), None)
    assert call.usage_complete and call.pricing_snapshot is None
    assert call.estimated_cost_usd is None
    record_usage(run, ModelCall(), usage(1, 1, 0), RATES)
    assert run.total_tokens == 2 and run.estimated_cost_usd is None
    assert run.execution_cursor == {"token_usage_complete": True, "cost_complete": False}


def test_missing_cache_split_can_be_priced_if_it_cannot_affect_cost() -> None:
    run, call = Run(), ModelCall()
    record_usage(run, call, usage(8, 4, None), Pricing(Decimal("2"), Decimal("4"), Decimal("2")))
    assert call.estimated_cost_usd == Decimal("0.000032")
    record_usage(run, ModelCall(), usage(0, 1, None), RATES)
    assert run.estimated_cost_usd == Decimal("0.000036")


def test_run_cost_sums_storeable_call_estimates_rounding_ties_like_postgres() -> None:
    rates = Pricing(Decimal("0.00005"), Decimal(0), Decimal(0))
    run, call = Run(), ModelCall()
    record_usage(run, call, usage(1, 0, 0), rates)
    record_usage(run, ModelCall(), usage(1, 0, 0), rates)
    assert call.estimated_cost_usd == Decimal("0.0000000001")
    assert run.estimated_cost_usd == Decimal("0.0000000002")


@pytest.mark.parametrize(
    "bad",
    [
        usage(-1, 3, 0),
        usage(2, -1, 0),
        usage(2, 3, -1),
        usage(2, 3, 3),
        usage(1 << 31, 1, 0),
        usage(True, 1, 0),
        ModelEvent(type=ModelEventType.text_delta),
    ],
)
def test_invalid_usage_cannot_partially_mutate_totals(bad: ModelEvent) -> None:
    run, call = Run(total_tokens=7, estimated_cost_usd=Decimal("3.14")), ModelCall()
    with pytest.raises(ValueError):
        record_usage(run, call, bad, RATES)
    assert run.total_tokens == 7 and run.estimated_cost_usd == Decimal("3.14")
    assert call.input_tokens is None and call.pricing_snapshot is None


@pytest.mark.parametrize("invalid", ["-0.1", "NaN", "Infinity"])
def test_pricing_requires_finite_nonnegative_rates(invalid: str) -> None:
    with pytest.raises(ValueError):
        Pricing(Decimal(0), Decimal(invalid), Decimal(0))
