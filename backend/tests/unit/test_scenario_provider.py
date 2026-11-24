"""Unit tests for deterministic multi-turn scenario provider across worker claims."""

import json

from app.agent.contracts import ModelEventType, ProviderMessage
from app.agent.scenario_provider import ScenarioProvider


async def test_scenario_provider_draft_turn_progression() -> None:
    provider = ScenarioProvider()
    messages: list[ProviderMessage] = [
        ProviderMessage(role="system", content="You are an operations copilot."),
        ProviderMessage(
            role="user",
            content="Find orders over $500 that shipped late last month and draft a refund email for each.",
        ),
    ]

    # Turn 1: Should call date_math
    events_t1 = [e async for e in provider.stream_turn(messages, [])]
    assert len(events_t1) == 2
    assert events_t1[0].type == ModelEventType.tool_call
    assert events_t1[0].tool_name == "date_math"
    assert events_t1[1].type == ModelEventType.turn_complete

    # Simulate date_math result
    messages.append(
        ProviderMessage(
            role="assistant",
            tool_calls=[{"id": "call-date-draft", "name": "date_math"}],
        )
    )
    messages.append(
        ProviderMessage(
            role="tool",
            name="date_math",
            tool_call_id="call-date-draft",
            content=json.dumps(
                {
                    "ok": True,
                    "data": {
                        "shipped_after": "2026-01-01T00:00:00+00:00",
                        "shipped_before": "2026-02-01T00:00:00+00:00",
                    },
                }
            ),
        )
    )

    # Turn 2: Should call query_orders with returned date bounds
    events_t2 = [e async for e in provider.stream_turn(messages, [])]
    assert len(events_t2) == 2
    assert events_t2[0].type == ModelEventType.tool_call
    assert events_t2[0].tool_name == "query_orders"
    assert events_t2[0].arguments["shipped_after"] == "2026-01-01T00:00:00+00:00"
    assert events_t2[0].arguments["shipped_before"] == "2026-02-01T00:00:00+00:00"

    # Simulate query_orders result
    messages.append(
        ProviderMessage(
            role="assistant",
            tool_calls=[{"id": "call-query-draft", "name": "query_orders"}],
        )
    )
    messages.append(
        ProviderMessage(
            role="tool",
            name="query_orders",
            tool_call_id="call-query-draft",
            content=json.dumps({"ok": True, "data": {"orders": [{"id": "ORD-1001"}, {"id": "ORD-1004"}], "count": 2}}),
        )
    )

    # Turn 3: Should search policies for EMAIL-01
    events_t3 = [e async for e in provider.stream_turn(messages, [])]
    assert len(events_t3) == 2
    assert events_t3[0].type == ModelEventType.tool_call
    assert events_t3[0].tool_name == "search_policies"

    # Simulate policy search result
    messages.append(
        ProviderMessage(
            role="assistant",
            tool_calls=[{"id": "call-pol-draft", "name": "search_policies"}],
        )
    )
    messages.append(
        ProviderMessage(
            role="tool",
            name="search_policies",
            tool_call_id="call-pol-draft",
            content=json.dumps({"ok": True, "data": "EMAIL-01: Late shipment notification template"}),
        )
    )

    # Turn 4: Final drafted response without any refund tool call
    events_t4 = [e async for e in provider.stream_turn(messages, [])]
    assert any(e.type == ModelEventType.text_delta and "ORD-1001" in e.text for e in events_t4)
    assert not any(e.type == ModelEventType.tool_call for e in events_t4)
    assert any(e.type == ModelEventType.usage for e in events_t4)


async def test_scenario_provider_approval_resume() -> None:
    provider = ScenarioProvider()
    messages: list[ProviderMessage] = [
        ProviderMessage(role="system", content="You are an operations copilot."),
        ProviderMessage(
            role="user",
            content="Find order ORD-1001 that shipped late and propose a simulated refund under policy.",
        ),
    ]

    # Turn 1: checks order
    e1 = [e async for e in provider.stream_turn(messages, [])]
    assert e1[0].tool_name == "query_orders"

    messages.append(ProviderMessage(role="assistant", tool_calls=[{"id": "c1", "name": "query_orders"}]))
    messages.append(
        ProviderMessage(
            role="tool",
            name="query_orders",
            tool_call_id="c1",
            content=json.dumps({"ok": True, "data": [{"id": "ORD-1001", "amount_minor": 62500}]}),
        )
    )

    # Turn 2: checks policy
    e2 = [e async for e in provider.stream_turn(messages, [])]
    assert e2[0].tool_name == "search_policies"

    messages.append(ProviderMessage(role="assistant", tool_calls=[{"id": "c2", "name": "search_policies"}]))
    messages.append(
        ProviderMessage(role="tool", name="search_policies", tool_call_id="c2", content=json.dumps({"ok": True}))
    )

    # Turn 3: proposes issue_refund
    e3 = [e async for e in provider.stream_turn(messages, [])]
    assert e3[0].tool_name == "issue_refund"
    assert e3[0].arguments["order_id"] == "ORD-1001"
    assert "amount_minor" not in e3[0].arguments

    # Simulate approval resumption in a NEW provider instance (as done by a new worker claim)
    new_provider = ScenarioProvider()
    messages.append(ProviderMessage(role="assistant", tool_calls=[{"id": "c3", "name": "issue_refund"}]))
    messages.append(
        ProviderMessage(
            role="tool",
            name="issue_refund",
            tool_call_id="c3",
            content=json.dumps({"ok": True, "data": {"refund_id": "REF-1001", "amount_minor": 6250}}),
        )
    )

    # Turn 4: Acknowledges approved refund without calling issue_refund again
    e4 = [e async for e in new_provider.stream_turn(messages, [])]
    assert not any(e.type == ModelEventType.tool_call for e in e4)
    assert any("REF-1001" in e.text for e in e4 if e.type == ModelEventType.text_delta)


async def test_scenario_provider_rejection_resume() -> None:
    provider = ScenarioProvider()
    messages: list[ProviderMessage] = [
        ProviderMessage(role="system", content="You are an operations copilot."),
        ProviderMessage(role="user", content="Propose a refund for ORD-1006 under policy."),
    ]

    # Query order
    _ = [e async for e in provider.stream_turn(messages, [])]
    messages.append(ProviderMessage(role="assistant", tool_calls=[{"id": "c1", "name": "query_orders"}]))
    messages.append(
        ProviderMessage(
            role="tool",
            name="query_orders",
            tool_call_id="c1",
            content=json.dumps({"ok": True, "data": [{"id": "ORD-1006"}]}),
        )
    )

    # Request policy evidence before proposing the refund.
    _ = [e async for e in provider.stream_turn(messages, [])]
    messages.append(ProviderMessage(role="tool", name="search_policies", content='{"ok":true,"data":{"matches":[]}}'))
    _ = [e async for e in provider.stream_turn(messages, [])]
    messages.append(ProviderMessage(role="assistant", tool_calls=[{"id": "c2", "name": "issue_refund"}]))
    messages.append(
        ProviderMessage(
            role="tool",
            name="issue_refund",
            tool_call_id="c2",
            content=json.dumps(
                {
                    "ok": False,
                    "error": {"code": "APPROVAL_REJECTED", "message": "Customer requested store credit."},
                }
            ),
        )
    )

    # Next turn: acknowledges rejection
    e3 = [e async for e in provider.stream_turn(messages, [])]
    assert not any(e.type == ModelEventType.tool_call for e in e3)
    assert any("Customer requested store credit" in e.text for e in e3 if e.type == ModelEventType.text_delta)
