"""Approved refunds bind evidence and persist exactly once with their result."""

import asyncio
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent.loop import save_tool_result
from app.models import Approval, Message, Order, Refund, Run, RunEventRecord, ToolCall
from app.runs.refunds import propose, resolve
from app.runs.schemas import ToolResult
from app.runs.service import create_run
from tests.integration.accounts import create_user

type Sessions = async_sessionmaker[AsyncSession]
type Request = tuple[UUID, UUID]


async def prepare(sessions: Sessions, *, approval_status: str | None = "approved") -> Request:
    owner = await create_user(sessions)
    async with sessions() as session:
        created = await create_run(session, owner.id, "Refund the late shipment")
        async with session.begin():
            run = await session.get_one(Run, created.id, with_for_update=True)
            run.status = "running"
            if await session.get(Order, "late") is None:
                promised = datetime(2026, 1, 1, tzinfo=UTC)
                session.add(
                    Order(
                        id="late",
                        customer_name="A",
                        customer_email="a@example.org",
                        amount_minor=50000,
                        status="shipped",
                        promised_ship_at=promised,
                        shipped_at=promised + timedelta(days=2),
                    )
                )
            message = Message(run_id=run.id, index=1, role="assistant", text=None)
            session.add(message)
            await session.flush()
            call = ToolCall(
                run_id=run.id,
                message_id=message.id,
                provider_call_id="refund",
                name="issue_refund",
                arguments={"order_id": "late", "reason": "Shipment was late"},
            )
            session.add(call)
            await session.flush()
            if approval_status is not None:
                assert await propose(session, run, call) is None
                approval = (await session.scalars(select(Approval).where(Approval.tool_call_id == call.id))).one()
                approval.status = approval_status
                if approval_status != "pending":
                    approval.decided_at = datetime.now(UTC)
                if approval_status == "rejected":
                    approval.reason = "Customer declined the adjustment"
                run.status = "running"
            return run.id, call.id


async def execute(sessions: Sessions, request: Request, *, barrier: asyncio.Barrier | None = None) -> ToolResult:
    async with sessions.begin() as session:
        run = await session.get_one(Run, request[0], with_for_update=True)
        call = await session.get_one(ToolCall, request[1])
        if barrier is not None:
            await barrier.wait()
        return await resolve(session, run, call)


async def assert_no_refund(sessions: Sessions) -> None:
    async with sessions() as session:
        assert await session.scalar(select(func.count()).select_from(Refund)) == 0
        assert (await session.get_one(Order, "late")).status == "shipped"


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (None, "APPROVAL_REQUIRED"),
        ("pending", "APPROVAL_REQUIRED"),
        ("rejected", "APPROVAL_REJECTED"),
        ("cancelled", "APPROVAL_CANCELLED"),
    ],
)
async def test_unapproved_requests_cannot_write(sessions: Sessions, status: str | None, code: str) -> None:
    request = await prepare(sessions, approval_status=status)
    result = await execute(sessions, request)
    assert not result.ok and result.error.code == code
    await assert_no_refund(sessions)


@pytest.mark.parametrize("changed", ["digest", "amount", "evidence"])
async def test_tampered_approved_proposals_cannot_write(sessions: Sessions, changed: str) -> None:
    request = await prepare(sessions)
    async with sessions.begin() as session:
        call = await session.get_one(ToolCall, request[1])
        approval = (await session.scalars(select(Approval).where(Approval.tool_call_id == call.id))).one()
        proposal = deepcopy(approval.proposed_arguments)
        if changed == "digest":
            approval.arguments_digest = "0" * 64
        elif changed == "amount":
            proposal["amount_minor"] = 10000
        else:
            evidence = proposal["evidence"]
            assert isinstance(evidence, dict)
            evidence["shipped_at"] = "2026-01-10T00:00:00+00:00"
        approval.proposed_arguments = proposal
    result = await execute(sessions, request)
    assert not result.ok and result.error.code == "APPROVAL_CHANGED"
    await assert_no_refund(sessions)


@pytest.mark.parametrize("changed", ["amount", "shipped_at", "promised_ship_at", "status"])
async def test_changed_live_evidence_requires_new_review(sessions: Sessions, changed: str) -> None:
    request = await prepare(sessions)
    async with sessions.begin() as session:
        order = await session.get_one(Order, "late")
        if changed == "amount":
            # This one-cent change leaves the rounded refund unchanged.
            order.amount_minor += 1
        elif changed == "shipped_at":
            assert order.shipped_at is not None
            order.shipped_at += timedelta(hours=1)
        elif changed == "promised_ship_at":
            order.promised_ship_at -= timedelta(hours=1)
        else:
            order.status = "delivered"
    result = await execute(sessions, request)
    assert not result.ok and result.error.code == "REFUND_DATA_CHANGED"
    async with sessions() as session:
        assert await session.scalar(select(func.count()).select_from(Refund)) == 0


async def test_changed_remaining_balance_requires_new_review(sessions: Sessions) -> None:
    request = await prepare(sessions)
    other = await prepare(sessions)
    async with sessions.begin() as session:
        session.add(
            Refund(
                order_id="late",
                tool_call_id=other[1],
                policy_version="previous-policy",
                amount_minor=100,
                currency="USD",
                reason="Earlier adjustment",
            )
        )
    result = await execute(sessions, request)
    assert not result.ok and result.error.code == "REFUND_DATA_CHANGED"
    async with sessions() as session:
        refunds = (await session.scalars(select(Refund))).all()
        assert len(refunds) == 1 and refunds[0].policy_version == "previous-policy"
        assert (await session.get_one(Order, "late")).status == "shipped"


async def test_repeated_approved_call_returns_same_refund(sessions: Sessions) -> None:
    request = await prepare(sessions)
    first = await execute(sessions, request)
    retry = await execute(sessions, request)
    assert first.ok and retry.ok
    assert first.data["already_issued"] is False
    assert retry.data["already_issued"] is True
    assert first.data["refund_id"] == retry.data["refund_id"]
    async with sessions() as session:
        assert await session.scalar(select(func.count()).select_from(Refund)) == 1
        assert (await session.get_one(Order, "late")).status == "partially_refunded"


async def test_two_approved_runs_concurrently_refund_order_only_once(sessions: Sessions) -> None:
    first = await prepare(sessions)
    second = await prepare(sessions)
    barrier = asyncio.Barrier(2)
    async with asyncio.timeout(10):
        results = await asyncio.gather(
            execute(sessions, first, barrier=barrier), execute(sessions, second, barrier=barrier)
        )
    assert all(result.ok for result in results)
    success = [result for result in results if result.ok]
    assert {result.data["already_issued"] for result in success} == {False, True}
    assert success[0].data["refund_id"] == success[1].data["refund_id"]
    async with sessions() as session:
        refunds = (await session.scalars(select(Refund))).all()
        assert len(refunds) == 1 and refunds[0].amount_minor == 5000
        assert refunds[0].tool_call_id in {first[1], second[1]}


async def test_result_persistence_failure_rolls_back_refund_and_order(sessions: Sessions) -> None:
    request = await prepare(sessions)
    async with sessions() as session:
        sequence_before = (await session.get_one(Run, request[0])).next_event_sequence
    with pytest.raises(IntegrityError):
        async with sessions.begin() as session:
            run = await session.get_one(Run, request[0], with_for_update=True)
            call = await session.get_one(ToolCall, request[1])
            result = await resolve(session, run, call)
            assert result.ok
            # An existing assistant message owns index 1: force a real result-write failure.
            await save_tool_result(session, call, result, index=1)
    await assert_no_refund(sessions)
    async with sessions() as session:
        call = await session.get_one(ToolCall, request[1])
        assert call.result is None and call.status == "awaiting_approval"
        assert (await session.get_one(Run, request[0])).next_event_sequence == sequence_before
        assert (
            await session.scalar(
                select(func.count()).select_from(RunEventRecord).where(RunEventRecord.type == "tool.completed")
            )
            == 0
        )
    assert (await execute(sessions, request)).ok


async def test_saved_call_arguments_are_immutable(sessions: Sessions) -> None:
    request = await prepare(sessions)
    with pytest.raises(IntegrityError, match="Saved tool-call arguments"):
        async with sessions.begin() as session:
            call = await session.get_one(ToolCall, request[1])
            call.arguments = {**call.arguments, "reason": "Different reason"}
    await assert_no_refund(sessions)
