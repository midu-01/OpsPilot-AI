"""Approval and simulated refunds; caller locks run and commits result with ledger."""

from __future__ import annotations

import hashlib
import hmac
import json

from pydantic import JsonValue, ValidationError
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Approval, Order, Refund, Run, ToolCall
from app.runs.schemas import EventType, ToolError, ToolFailure, ToolResult, ToolSuccess
from app.runs.service import append_event
from app.tools.issue_refund import POLICY_VERSION, IssueRefundArgs, preview


def arguments_digest(call: ToolCall, proposal: dict[str, JsonValue]) -> str:
    """Bind original arguments and frozen evidence to the owning run and tool call."""
    value = {
        "run_id": str(call.run_id),
        "tool_call_id": str(call.id),
        "tool_name": call.name,
        "arguments": call.arguments,
        "proposal": proposal,
    }
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def failure(code: str, message: str) -> ToolFailure:
    return ToolFailure(error=ToolError(code=code, message=message))


def cancelled(run: Run) -> bool:
    return run.cancellation_requested or run.status in {"cancelling", "cancelled"}


def success(refund: Refund, *, already_issued: bool) -> ToolSuccess:
    return ToolSuccess(
        data={
            "simulated": True,
            "refund_id": str(refund.id),
            "order_id": refund.order_id,
            "amount_minor": refund.amount_minor,
            "currency": refund.currency,
            "policy_version": refund.policy_version,
            "already_issued": already_issued,
        }
    )


async def propose(session: AsyncSession, run: Run, call: ToolCall) -> ToolResult | None:
    """Freeze an eligible proposal and pause without dispatching a write tool."""
    if cancelled(run):
        return failure("RUN_CANCELLED", "The run was cancelled before refund approval")
    if call.run_id != run.id or call.name != "issue_refund":
        return failure("INVALID_ARGUMENTS", "The refund request does not belong to this run")
    try:
        args = IssueRefundArgs.model_validate(call.arguments)
    except ValidationError:
        return failure("INVALID_ARGUMENTS", "Invalid refund arguments")
    existing = await session.scalar(select(Approval).where(Approval.tool_call_id == call.id))
    if existing is not None:
        return failure("APPROVAL_EXISTS", "This tool call already has an approval proposal")
    evidence = await preview(args, session=session)
    if evidence.get("eligible") is not True:
        return failure("REFUND_INELIGIBLE", str(evidence.get("error", "Refund is not eligible")))
    proposal: dict[str, JsonValue] = {
        "order_id": args.order_id,
        "reason": args.reason,
        "policy_version": POLICY_VERSION,
        "amount_minor": evidence["refund_amount_minor"],
        "currency": evidence["currency"],
        "evidence": evidence,
    }
    approval = Approval(
        run_id=run.id,
        tool_call_id=call.id,
        proposed_arguments=proposal,
        arguments_digest=arguments_digest(call, proposal),
    )
    session.add(approval)
    call.status = "awaiting_approval"
    run.status = "awaiting_approval"
    await session.flush()
    await append_event(
        session,
        run.id,
        EventType.approval_required,
        {
            "approval_id": str(approval.id),
            "tool_call_id": str(call.id),
            "tool_name": call.name,
            "proposed_arguments": proposal,
            "status": "pending",
        },
    )
    return None


async def resolve(session: AsyncSession, run: Run, call: ToolCall) -> ToolResult:
    """Execute exactly the approved proposal under run then order row locks."""
    if cancelled(run):
        return failure("RUN_CANCELLED", "The run was cancelled before refund execution")
    if call.run_id != run.id or call.name != "issue_refund":
        return failure("INVALID_ARGUMENTS", "The refund request does not belong to this run")
    approval = await session.scalar(
        select(Approval).where(Approval.run_id == run.id, Approval.tool_call_id == call.id).with_for_update()
    )
    if approval is None or approval.status == "pending":
        return failure("APPROVAL_REQUIRED", "Human approval is required to issue a refund")
    if approval.status == "rejected":
        return failure("APPROVAL_REJECTED", approval.reason or "Refund approval was rejected")
    if approval.status != "approved":
        return failure("APPROVAL_CANCELLED", "The refund approval was cancelled")
    proposal = approval.proposed_arguments
    if not hmac.compare_digest(approval.arguments_digest, arguments_digest(call, proposal)):
        return failure("APPROVAL_CHANGED", "The refund request or approved proposal has changed")
    try:
        args = IssueRefundArgs.model_validate(call.arguments)
    except ValidationError:
        return failure("INVALID_ARGUMENTS", "Invalid refund arguments")
    amount = proposal.get("amount_minor")
    if (
        proposal.get("order_id") != args.order_id
        or proposal.get("reason") != args.reason
        or proposal.get("policy_version") != POLICY_VERSION
        or proposal.get("currency") != "USD"
        or type(amount) is not int
        or amount <= 0
    ):
        return failure("APPROVAL_CHANGED", "The approved refund arguments or policy version have changed")
    order = await session.scalar(select(Order).where(Order.id == args.order_id).with_for_update())
    if order is None:
        return failure("REFUND_DATA_CHANGED", "The approved order no longer exists")
    existing = await session.scalar(
        select(Refund).where(
            or_(
                Refund.tool_call_id == call.id,
                (Refund.order_id == args.order_id) & (Refund.policy_version == POLICY_VERSION),
            )
        )
    )
    if existing is not None:
        if (
            existing.order_id != args.order_id
            or existing.policy_version != POLICY_VERSION
            or existing.amount_minor != amount
            or existing.currency != "USD"
        ):
            return failure("REFUND_DATA_CHANGED", "An existing refund differs from the approved proposal")
        return success(existing, already_issued=True)
    evidence = await preview(args, session=session)
    if evidence.get("eligible") is not True or evidence.get("refund_amount_minor") != amount:
        return failure(
            "REFUND_DATA_CHANGED", "Order or refund policy data changed after approval; request a new review"
        )
    # Check changes even when the rounded adjustment would stay the same.
    frozen_evidence = proposal.get("evidence")
    if not isinstance(frozen_evidence, dict) or any(
        evidence.get(key) != frozen_evidence.get(key)
        for key in (
            "status",
            "order_amount_minor",
            "currency",
            "shipped_at",
            "promised_ship_at",
            "prior_refunds_minor",
            "remaining_balance_minor",
            "policy_ids",
        )
    ):
        return failure(
            "REFUND_DATA_CHANGED", "Order or refund policy data changed after approval; request a new review"
        )
    refund = Refund(
        order_id=args.order_id,
        tool_call_id=call.id,
        policy_version=POLICY_VERSION,
        amount_minor=amount,
        currency="USD",
        reason=args.reason,
    )
    session.add(refund)
    order.status = "refunded" if evidence["remaining_balance_minor"] == amount else "partially_refunded"
    await session.flush()
    return success(refund, already_issued=False)
