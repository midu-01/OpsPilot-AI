"""Refund proposals use persisted shipping and ledger evidence without writing."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Approval, Message, Order, Refund, Run, ToolCall
from app.tools.issue_refund import IssueRefundArgs, execute, preview

PROMISE = datetime(2026, 10, 1, 12, tzinfo=UTC)


def order(status: str = "shipped", delay: int | None = 1) -> Order:
    return Order(
        id=f"ORD-{uuid4().hex}",
        customer_name="Demo Customer",
        customer_email="customer@example.test",
        amount_minor=84505,
        currency="USD",
        status=status,
        promised_ship_at=PROMISE,
        shipped_at=PROMISE + timedelta(seconds=delay) if delay is not None else None,
    )


def request(item: Order) -> IssueRefundArgs:
    return IssueRefundArgs(order_id=item.id, reason="Late shipment under LATE-01")


async def record_refund(session: AsyncSession, item: Order, version: str, amount: int) -> Refund:
    run = Run(goal="Review adjustment", model="fake", provider="fake", reference_time=PROMISE, business_timezone="UTC")
    session.add(run)
    await session.flush()
    message = Message(run_id=run.id, index=0, role="assistant")
    session.add(message)
    await session.flush()
    call = ToolCall(run_id=run.id, message_id=message.id, provider_call_id="call", name="issue_refund", arguments={})
    session.add(call)
    await session.flush()
    refund = Refund(order_id=item.id, tool_call_id=call.id, amount_minor=amount, policy_version=version, reason="Prior")
    session.add(refund)
    await session.flush()
    return refund


async def test_preview_and_direct_execution_leave_ledger_and_approvals_empty(db_session: AsyncSession) -> None:
    item = order("delivered")
    db_session.add(item)
    await db_session.flush()
    # The preview must neither flush unrelated work nor quote a caller's unpersisted order edits.
    item.amount_minor = 1
    pending = order()
    db_session.add(pending)
    result = await preview(request(item), session=db_session)
    assert result["eligible"] is True and result["requires_approval"] is True
    assert result["refund_amount_minor"] == 8451
    assert result["order_amount_minor"] == result["remaining_balance_minor"] == 84505
    assert result["prior_refunds_minor"] == 0
    assert result["policy_version"] == "v1"
    assert result["shipped_at"] == (PROMISE + timedelta(seconds=1)).isoformat()
    assert result["promised_ship_at"] == PROMISE.isoformat()

    with pytest.raises(PermissionError, match="approval"):
        await execute(request(item), session=db_session)
    assert item in db_session.dirty and pending in db_session.new
    with db_session.no_autoflush:
        assert await db_session.scalar(select(func.count()).select_from(Refund)) == 0
        assert await db_session.scalar(select(func.count()).select_from(Approval)) == 0


async def test_partial_balance_and_duplicate_use_ledger_evidence(db_session: AsyncSession) -> None:
    item = order("partially_refunded")
    db_session.add(item)
    await record_refund(db_session, item, "unrelated-v1", 84000)
    args = request(item)
    result = await preview(args, session=db_session)
    assert result["eligible"] is True
    assert result["refund_amount_minor"] == result["remaining_balance_minor"] == 505
    issued = await record_refund(db_session, item, "v1", 505)
    repeated = await preview(args, session=db_session)
    assert repeated["eligible"] is False
    assert repeated["existing_refund_id"] == str(issued.id)
    assert repeated["existing_refund_amount_minor"] == 505
    assert await db_session.scalar(select(func.count()).select_from(Refund)) == 2


async def test_exhausted_and_inconsistent_ledger_balances(db_session: AsyncSession) -> None:
    for status, previous, review in (
        ("shipped", 84505, False),
        ("refunded", 84505, False),
        ("partially_refunded", 84505, True),
        ("shipped", 84506, True),
    ):
        item = order(status)
        db_session.add(item)
        await record_refund(db_session, item, "unrelated-v1", previous)
        result = await preview(request(item), session=db_session)
        assert result["eligible"] is False and result["requires_review"] is review
        assert result["prior_refunds_minor"] == previous
        assert "refund_amount_minor" not in result


async def test_exclusions_and_inconsistent_records(db_session: AsyncSession) -> None:
    cases = [
        ("cancelled", None, "cancelled"),
        ("pending", None, "unshipped"),
        ("shipped", None, "shipment"),
        ("shipped", 0, "on time"),
        ("delivered", -1, "on time"),
        ("refunded", 1, "fully refunded"),
        ("partially_refunded", 1, "ledger"),
        ("pending", 1, "conflict"),
    ]
    for status, delay, message in cases:
        item = order(status, delay)
        db_session.add(item)
        await db_session.flush()
        result = await preview(request(item), session=db_session)
        assert result["eligible"] is False
        assert message in str(result["error"]).lower()
        if status == "partially_refunded" or (status == "pending" and delay):
            assert result["requires_review"] is True
    missing = await preview(IssueRefundArgs(order_id="unknown", reason="Late"), session=db_session)
    assert missing["eligible"] is False and "not found" in str(missing["error"])
    assert await db_session.scalar(select(func.count()).select_from(Refund)) == 0


def test_refund_arguments_reject_forged_authority_amounts_and_unbounded_values() -> None:
    for extra in ({"approved": True}, {"approval_id": "claimed"}, {"eligible": True}, {"refund_amount_minor": 1}):
        with pytest.raises(ValidationError):
            IssueRefundArgs.model_validate({"order_id": "order", "reason": "late", **extra})
    for field in ("order_id", "reason"):
        for value in ("   ", "x" * 3000, 42, "abc\x00def"):
            with pytest.raises(ValidationError):
                IssueRefundArgs.model_validate({"order_id": "order", "reason": "late", field: value})
