"""Deterministic scenario-driven provider for keyless testing and offline demos."""

import json
import re
from collections.abc import AsyncIterator
from datetime import date
from typing import Any

from app.agent.contracts import LLMProvider, ModelEvent, ModelEventType, ProviderMessage, ToolDefinition


class ScenarioProvider(LLMProvider):
    """Deterministic fixture using saved observations; it never executes tools itself."""

    def __init__(self, reference_date: date = date(2026, 2, 15)) -> None:
        self.reference_date = reference_date

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

        requested_order = re.search(r"\bord-\d+\b", goal)
        writes_requested = "draft" not in goal and any(word in goal for word in ("issue", "propose", "refund"))
        if requested_order and writes_requested:
            order_id = requested_order.group().upper()
            if not has_query:
                yield ModelEvent(
                    ModelEventType.tool_call,
                    call_id="call-order-evidence",
                    tool_name="query_orders",
                    arguments={"sort_by": "id", "limit": 100},
                )
                yield ModelEvent(ModelEventType.turn_complete)
                return
            if not has_policy:
                yield ModelEvent(
                    ModelEventType.tool_call,
                    call_id="call-refund-policy",
                    tool_name="search_policies",
                    arguments={"query": "late shipment refund"},
                )
                yield ModelEvent(ModelEventType.turn_complete)
                return
            if not has_refund:
                yield ModelEvent(
                    ModelEventType.tool_call,
                    call_id="call-refund-proposal",
                    tool_name="issue_refund",
                    arguments={"order_id": order_id, "reason": "Review the late shipment under policy v1"},
                )
                yield ModelEvent(ModelEventType.turn_complete)
                return
            observed = tool_observations["issue_refund"]
            if observed.get("ok") is True:
                data = observed.get("data", {})
                text = (
                    f"The simulated refund for {data.get('order_id', order_id)} was approved and committed "
                    f"(ID: {data.get('refund_id')}). ${int(data['amount_minor']) / 100:.2f} "
                    f"{data.get('currency', 'USD')} was recorded in the simulated ledger."
                )
            else:
                error = observed.get("error", {})
                text = f"No refund was issued for {order_id}: {error.get('message', 'The refund request failed.')}"
            yield ModelEvent(ModelEventType.text_delta, text=text)
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
                    arguments={"operation": "previous_month", "reference_date": self.reference_date.isoformat()},
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
                arguments={"operation": "previous_month", "reference_date": self.reference_date.isoformat()},
            )
            yield ModelEvent(ModelEventType.turn_complete)
            return

        if not has_query:
            date_obs = tool_observations.get("date_math", {})
            date_data = date_obs.get("data", {}) if date_obs.get("ok") else {}
            start = date_data.get("shipped_after")
            end = date_data.get("shipped_before")
            query_args: dict[str, Any] = {
                "min_amount_minor": 50000,
                "late_only": True,
                "status": "shipped",
                "limit": 100,
            }
            if start and end:
                query_args["shipped_after"] = start
                query_args["shipped_before"] = end

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
        orders_data = orders_obs.get("data", {}) if orders_obs.get("ok") else {}
        orders_list = orders_data.get("orders", [])
        order_ids = [str(order["id"]) for order in orders_list if isinstance(order, dict) and order.get("id")]
        drafts = [
            f"Subject: Shipping delay for {order_id}\nDear Customer, we apologize for the shipping delay "
            f"on order {order_id}. Your refund eligibility can be reviewed under the late-shipment policy."
            for order_id in order_ids
        ]
        draft_content = (
            f"Found {len(order_ids)} qualifying orders. Email drafts follow policy EMAIL-01; "
            "no email was sent and no refund was issued.\n\n" + "\n\n".join(drafts)
        )
        if not order_ids:
            draft_content = "No matching orders were found. No email drafts or refunds were created."

        yield ModelEvent(ModelEventType.text_delta, text=draft_content)
        yield ModelEvent(ModelEventType.usage, input_tokens=320, output_tokens=110)
        yield ModelEvent(ModelEventType.turn_complete)
