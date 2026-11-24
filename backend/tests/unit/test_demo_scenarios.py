"""Offline scenarios must call the real typed tool contracts and use real observations."""

import json

import pytest

from app.agent.contracts import ModelEventType, ProviderMessage
from app.agent.scenario_provider import ScenarioProvider
from app.tools.date_math import DateMathArgs
from app.tools.date_math import execute as date_math
from app.tools.issue_refund import IssueRefundArgs
from app.tools.query_orders import QueryOrdersArgs
from app.tools.search_policies import SearchPoliciesArgs


def observation(name: str, data: object, *, ok: bool = True) -> ProviderMessage:
    return ProviderMessage("tool", json.dumps({"ok": ok, "data" if ok else "error": data}), name=name)


async def test_draft_calls_valid_filters_using_the_fixed_seed_period() -> None:
    provider = ScenarioProvider()
    history = [
        ProviderMessage("user", "Find orders over $500 that shipped late last month and draft a refund email for each.")
    ]
    first = [event async for event in provider.stream_turn(history, [])]
    args = DateMathArgs.model_validate(first[0].arguments)
    assert str(args.reference_date) == "2026-02-15"
    dates = await date_math(args)
    history.append(observation("date_math", dates))
    second = [event async for event in provider.stream_turn(history, [])]
    filters = QueryOrdersArgs.model_validate(second[0].arguments)
    assert filters.shipped_after and filters.shipped_after.isoformat() == "2026-01-01T00:00:00+00:00"
    assert filters.shipped_before and filters.shipped_before.isoformat() == "2026-02-01T00:00:00+00:00"
    assert filters.min_amount_minor == 50000 and filters.late_only
    history.append(
        observation(
            "query_orders", {"orders": [{"id": "ORD-1001"}, {"id": "ORD-1030"}], "count": 2, "limit": 100, "offset": 0}
        )
    )
    policy = [event async for event in provider.stream_turn(history, [])]
    assert SearchPoliciesArgs.model_validate(policy[0].arguments).query == "EMAIL-01"
    history.append(
        observation(
            "search_policies",
            {"matches": [{"id": "EMAIL-01", "excerpt": "Do not claim a refund has been issued"}], "total_policies": 8},
        )
    )
    final = [event async for event in provider.stream_turn(history, [])]
    text = "".join(event.text for event in final)
    assert "ORD-1001" in text and "ORD-1030" in text
    assert not any(event.type == ModelEventType.tool_call for event in final)


@pytest.mark.parametrize("order_id", ["ORD-1001", "ORD-1006"])
async def test_refund_proposal_uses_typed_arguments_and_approval_observation(order_id: str) -> None:
    provider = ScenarioProvider()
    history = [ProviderMessage("user", f"Please issue the eligible simulated refund for {order_id}.")]
    query = [event async for event in provider.stream_turn(history, [])]
    QueryOrdersArgs.model_validate(query[0].arguments)
    history.append(observation("query_orders", {"orders": [{"id": order_id}], "count": 1, "offset": 0, "limit": 100}))
    policy = [event async for event in provider.stream_turn(history, [])]
    assert policy[0].tool_name == "search_policies"
    history.append(observation("search_policies", {"matches": [{"id": "LATE-01", "version": "v1"}]}))
    proposal = [event async for event in provider.stream_turn(history, [])]
    assert IssueRefundArgs.model_validate(proposal[0].arguments).order_id == order_id
    assert "amount_minor" not in proposal[0].arguments
    history.append(
        observation(
            "issue_refund",
            {
                "refund_id": "ledger-proof",
                "order_id": order_id,
                "amount_minor": 8451,
                "currency": "USD",
                "simulated": True,
            },
        )
    )
    final = [event async for event in ScenarioProvider().stream_turn(history, [])]
    text = "".join(event.text for event in final)
    assert "ledger-proof" in text and "84.51" in text
    assert "rejected" not in text.lower()


async def test_failed_refund_observation_never_claims_a_committed_refund() -> None:
    history = [
        ProviderMessage("user", "Propose a refund for ORD-1001 under policy."),
        observation("query_orders", {"orders": [{"id": "ORD-1001"}]}),
        observation("search_policies", {"matches": []}),
        observation("issue_refund", {"code": "REFUND_INELIGIBLE", "message": "Order shipped on time"}, ok=False),
    ]
    final = [event async for event in ScenarioProvider().stream_turn(history, [])]
    text = "".join(event.text for event in final)
    assert "Order shipped on time" in text
    assert "approved and committed" not in text
    assert "REF-SIMULATED" not in text
