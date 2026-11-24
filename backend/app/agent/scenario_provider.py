"""Deterministic scenario-driven provider for keyless testing and offline demos."""

import json
import re
from collections.abc import AsyncIterator
from datetime import date, datetime
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
        if orders_list:
            draft_blocks: list[str] = []
            for i, order in enumerate(orders_list, start=1):
                order_id = str(order.get("id", f"ORD-{1000 + i}"))
                customer_name = str(order.get("customer_name", f"Demo Customer {i:02d}"))
                customer_email = str(order.get("customer_email", f"customer{i:02d}@example.test"))
                amount_minor = order.get("amount_minor", 62500)
                amount_usd = f"{amount_minor / 100:.2f}"

                promised_str = str(order.get("promised_ship_at", ""))
                shipped_str = str(order.get("shipped_at", ""))
                try:
                    promised_dt = datetime.fromisoformat(promised_str)
                    shipped_dt = datetime.fromisoformat(shipped_str)
                    delay_days = max(1, (shipped_dt.date() - promised_dt.date()).days)
                    promised_fmt = promised_dt.strftime("%B %d, %Y")
                    shipped_fmt = shipped_dt.strftime("%B %d, %Y")
                except Exception:
                    delay_days = 2
                    promised_fmt = "September 29, 2026"
                    shipped_fmt = "October 1, 2026"

                draft_blocks.append(
                    f"## **Draft Email {i}**\n\n"
                    f"**To:** {customer_email}  \n"
                    f"**Subject:** Refund for Late Delivery - Order {order_id}\n\n"
                    f"Dear {customer_name},\n\n"
                    f"We sincerely apologize for the delayed delivery of your order {order_id} (USD ${amount_usd}). "
                    f"Your order was promised to ship by {promised_fmt}, but unfortunately shipped on {shipped_fmt} – "
                    f"{delay_days} days late.\n\n"
                    "As a gesture of goodwill and in accordance with our late-shipment policy, "
                    "we would like to issue you a refund for this inconvenience.\n\n"
                    "Please let us know if you have any questions.\n\n"
                    "Best regards,  \nOperations Team"
                )

            draft_content = (
                f"Perfect! I found {len(orders_list)} orders over $500 that shipped late last month. "
                "Following policy EMAIL-01, here are the draft refund emails for each:\n\n---\n\n"
                + "\n\n---\n\n".join(draft_blocks)
                + "\n\n---\n\n"
                f"**Summary:** Found **{len(orders_list)} late orders over $500**, "
                "ranging from $625.00 to $845.05, with delays of 2-3 days each. "
                "All emails are ready for review and sending."
            )
        else:
            draft_content = "No matching orders were found. No email drafts or refunds were created."

        yield ModelEvent(ModelEventType.text_delta, text=draft_content)
        yield ModelEvent(ModelEventType.usage, input_tokens=320, output_tokens=110)
        yield ModelEvent(ModelEventType.turn_complete)
