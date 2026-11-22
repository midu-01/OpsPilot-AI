"""Deterministic scenario-driven provider for keyless testing and offline demos."""

import json
from collections.abc import AsyncIterator
from typing import Any

from app.agent.contracts import LLMProvider, ModelEvent, ModelEventType, ProviderMessage, ToolDefinition


class ScenarioProvider(LLMProvider):
    """Stateless deterministic provider that resolves turns from message history."""

    async def stream_turn(
        self, messages: list[ProviderMessage], tools: list[ToolDefinition]
    ) -> AsyncIterator[ModelEvent]:
        # 1. Locate the user goal
        user_message = next((m for m in messages if m.role == "user"), None)
        goal = (user_message.content or "").lower() if user_message else ""

        # 2. Extract completed tool calls and their observations
        tool_observations: dict[str, dict[str, Any]] = {}
        for m in messages:
            if m.role == "tool" and m.name:
                try:
                    data = json.loads(m.content) if isinstance(m.content, str) else {}
                    tool_observations[m.name] = data
                except Exception:
                    tool_observations[m.name] = {}

        # Check which tools were called
        has_date = "date_math" in tool_observations
        has_query = "query_orders" in tool_observations
        has_policy = "search_policies" in tool_observations
        has_refund = "issue_refund" in tool_observations

        # Scenario A: Rejection flow (mentions ORD-1006 or reject)
        if "ord-1006" in goal or "reject" in goal:
            if not has_query:
                yield ModelEvent(
                    ModelEventType.tool_call,
                    call_id="call-ord-1006",
                    tool_name="query_orders",
                    arguments={"order_id": "ORD-1006"},
                )
                yield ModelEvent(ModelEventType.turn_complete)
                return
            if not has_refund:
                yield ModelEvent(
                    ModelEventType.tool_call,
                    call_id="call-ref-1006",
                    tool_name="issue_refund",
                    arguments={
                        "order_id": "ORD-1006",
                        "amount_minor": 8450,
                        "reason": "Late shipment policy v1 refund of 10%",
                    },
                )
                yield ModelEvent(ModelEventType.turn_complete)
                return

            # Observation received after decision
            obs = tool_observations["issue_refund"]
            reason = obs.get("error", {}).get("message", "Customer requested store credit.")
            yield ModelEvent(
                ModelEventType.text_delta,
                text=(
                    f"The refund proposal for order ORD-1006 was rejected by human operator ({reason}). "
                    "No refund was issued to the simulated ledger."
                ),
            )
            yield ModelEvent(ModelEventType.usage, input_tokens=180, output_tokens=45)
            yield ModelEvent(ModelEventType.turn_complete)
            return

        # Scenario B: Explicit Approval flow (mentions ORD-1001, propose, or approval)
        if "ord-1001" in goal or "propose" in goal or "simulated refund" in goal:
            if not has_query:
                yield ModelEvent(
                    ModelEventType.tool_call,
                    call_id="call-ord-1001",
                    tool_name="query_orders",
                    arguments={"order_id": "ORD-1001"},
                )
                yield ModelEvent(ModelEventType.turn_complete)
                return
            if not has_policy:
                yield ModelEvent(
                    ModelEventType.tool_call,
                    call_id="call-pol-1001",
                    tool_name="search_policies",
                    arguments={"query": "late shipment refund"},
                )
                yield ModelEvent(ModelEventType.turn_complete)
                return
            if not has_refund:
                yield ModelEvent(
                    ModelEventType.tool_call,
                    call_id="call-ref-1001",
                    tool_name="issue_refund",
                    arguments={
                        "order_id": "ORD-1001",
                        "amount_minor": 6250,
                        "reason": "Late shipment policy v1 refund of 10% on $625.00 order",
                    },
                )
                yield ModelEvent(ModelEventType.turn_complete)
                return

            # Observation received after approval
            obs = tool_observations["issue_refund"]
            refund_id = obs.get("data", {}).get("refund_id", "REF-SIMULATED")
            yield ModelEvent(
                ModelEventType.text_delta,
                text=(
                    f"The simulated refund for order ORD-1001 was approved and committed (ID: {refund_id}). "
                    "A refund of $62.50 USD has been recorded in the ledger."
                ),
            )
            yield ModelEvent(ModelEventType.usage, input_tokens=210, output_tokens=55)
            yield ModelEvent(ModelEventType.turn_complete)
            return

        # Scenario C: Zero matching orders
        if "zero" in goal or "over $10000" in goal or "over $10,000" in goal or "1000000" in goal:
            if not has_date:
                yield ModelEvent(
                    ModelEventType.tool_call,
                    call_id="call-date-zero",
                    tool_name="date_math",
                    arguments={"operation": "previous_month"},
                )
                yield ModelEvent(ModelEventType.turn_complete)
                return
            if not has_query:
                yield ModelEvent(
                    ModelEventType.tool_call,
                    call_id="call-query-zero",
                    tool_name="query_orders",
                    arguments={"min_amount_minor": 1000000, "late_only": True},
                )
                yield ModelEvent(ModelEventType.turn_complete)
                return

            yield ModelEvent(
                ModelEventType.text_delta,
                text="Zero matching orders were found exceeding $10,000. No refund drafts were generated.",
            )
            yield ModelEvent(ModelEventType.usage, input_tokens=120, output_tokens=25)
            yield ModelEvent(ModelEventType.turn_complete)
            return

        # Scenario D: Default Draft-only late shipment analysis
        if not has_date:
            yield ModelEvent(
                ModelEventType.tool_call,
                call_id="call-date-draft",
                tool_name="date_math",
                arguments={"operation": "previous_month"},
            )
            yield ModelEvent(ModelEventType.turn_complete)
            return

        if not has_query:
            date_obs = tool_observations.get("date_math", {})
            date_data = date_obs.get("data", {}) if date_obs.get("ok") else {}
            start = date_data.get("start")
            end = date_data.get("end")
            query_args: dict[str, Any] = {
                "min_amount_minor": 50000,
                "late_only": True,
                "status": "shipped",
            }
            if start and end:
                query_args["start"] = start
                query_args["end"] = end

            yield ModelEvent(
                ModelEventType.tool_call,
                call_id="call-query-draft",
                tool_name="query_orders",
                arguments=query_args,
            )
            yield ModelEvent(ModelEventType.turn_complete)
            return

        if not has_policy:
            yield ModelEvent(
                ModelEventType.tool_call,
                call_id="call-pol-draft",
                tool_name="search_policies",
                arguments={"query": "EMAIL-01"},
            )
            yield ModelEvent(ModelEventType.turn_complete)
            return

        # Final turn: compose drafts
        orders_obs = tool_observations.get("query_orders", {})
        orders_list = orders_obs.get("data", []) if orders_obs.get("ok") else []
        order_ids = [str(o["id"]) for o in orders_list if isinstance(o, dict) and o.get("id")]
        orders_summary = ", ".join(order_ids[:3]) if order_ids else "qualifying orders"

        draft_content = (
            f"Found {len(order_ids)} orders over $500 that shipped late last month ({orders_summary}).\n\n"
            "Here are the drafted refund notification emails in accordance with policy EMAIL-01:\n\n"
            "Subject: Apology & 10% Refund for Order Delay\n"
            "Dear Customer,\n\n"
            "We apologize for the delay in shipping your order. As promised by our Late Shipment Policy, "
            "a 10% refund draft has been calculated for your order.\n\n"
            "Sincerely,\nOpsPilot Operations Team"
        )

        yield ModelEvent(ModelEventType.text_delta, text=draft_content)
        yield ModelEvent(ModelEventType.usage, input_tokens=320, output_tokens=110)
        yield ModelEvent(ModelEventType.turn_complete)
