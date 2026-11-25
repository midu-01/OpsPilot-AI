"""Approval decisions and Stop share the worker's PostgreSQL run lock."""

import asyncio
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db import get_session
from app.main import app
from app.models import Approval, Message, Run, ToolCall, User
from app.runs.service import create_run, get_snapshot


@pytest.fixture
async def client(
    sessions: async_sessionmaker[AsyncSession], user_headers: dict[str, str]
) -> AsyncIterator[AsyncClient]:
    """Signed in as the `user` fixture, who owns every run that `proposal` creates in these tests."""

    async def isolated_session() -> AsyncIterator[AsyncSession]:
        async with sessions() as session:
            yield session

    app.dependency_overrides[get_session] = isolated_session
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test", headers=user_headers) as http:
            yield http
    finally:
        del app.dependency_overrides[get_session]


async def proposal(
    sessions: async_sessionmaker[AsyncSession], owner_id: UUID, status: str = "awaiting_approval"
) -> tuple[UUID, UUID]:
    async with sessions() as session:
        summary = await create_run(session, owner_id, "Refund a delayed order")
    async with sessions.begin() as session:
        run = await session.get_one(Run, summary.id)
        run.status = status
        message = Message(run_id=run.id, index=1, role="assistant", text=None)
        session.add(message)
        await session.flush()
        call = ToolCall(
            run_id=run.id,
            message_id=message.id,
            provider_call_id="refund-1",
            name="issue_refund",
            arguments={"order_id": "ORD-1", "amount": "20.00"},
            status="awaiting_approval",
        )
        session.add(call)
        await session.flush()
        approval = Approval(
            run_id=run.id, tool_call_id=call.id, proposed_arguments=call.arguments, arguments_digest="test"
        )
        session.add(approval)
        await session.flush()
        return run.id, approval.id


@pytest.mark.parametrize("decision,reason", [("approve", None), ("reject", "Outside policy")])
async def test_concurrent_identical_decisions_requeue_once(
    sessions: async_sessionmaker[AsyncSession],
    client: AsyncClient,
    user: User,
    decision: str,
    reason: str | None,
) -> None:
    run_id, approval_id = await proposal(sessions, user.id)
    action = {"approval_id": str(approval_id), "decision": decision, "reason": reason}
    replies = await asyncio.gather(*(client.post(f"/runs/{run_id}/approve", json=action) for _ in range(3)))
    assert [reply.status_code for reply in replies] == [200, 200, 200]
    assert all(reply.json()["status"] == "queued" for reply in replies)
    async with sessions() as session:
        snapshot = await get_snapshot(session, run_id)
    assert snapshot is not None
    assert snapshot.approvals[0].status == ("approved" if decision == "approve" else "rejected")
    assert snapshot.approvals[0].reason == reason
    assert snapshot.approvals[0].decided_at is not None
    assert [event.type for event in snapshot.events] == ["run.queued", "approval.decided", "run.queued"]
    assert snapshot.messages[1].tool_calls[0].result is None
    assert snapshot.step_count == 0


async def test_conflicting_decisions_and_changed_reason_are_rejected(
    sessions: async_sessionmaker[AsyncSession], client: AsyncClient, user: User
) -> None:
    run_id, approval_id = await proposal(sessions, user.id)
    action = {"approval_id": str(approval_id), "decision": "reject", "reason": "Too expensive"}
    assert (await client.post(f"/runs/{run_id}/approve", json=action)).status_code == 200
    for conflicting in ({**action, "reason": "Changed reason"}, {**action, "decision": "approve", "reason": None}):
        assert (await client.post(f"/runs/{run_id}/approve", json=conflicting)).status_code == 409


@pytest.mark.parametrize("status", ["completed", "failed"])
async def test_terminal_pending_decision_conflicts_but_exact_prior_decision_replays(
    sessions: async_sessionmaker[AsyncSession], client: AsyncClient, user: User, status: str
) -> None:
    run_id, approval_id = await proposal(sessions, user.id, status)
    action = {"approval_id": str(approval_id), "decision": "approve"}
    assert (await client.post(f"/runs/{run_id}/approve", json=action)).status_code == 409
    async with sessions.begin() as session:
        approval = await session.get_one(Approval, approval_id)
        approval.status = "approved"
        approval.decided_at = datetime.now(UTC)
    response = await client.post(f"/runs/{run_id}/approve", json=action)
    assert response.status_code == 200 and response.json()["status"] == status


async def test_missing_wrong_run_stale_and_invalid_approval_requests(
    sessions: async_sessionmaker[AsyncSession], client: AsyncClient, user: User
) -> None:
    run_id, approval_id = await proposal(sessions, user.id, "queued")
    action = {"approval_id": str(approval_id), "decision": "approve"}
    assert (await client.post(f"/runs/{uuid4()}/approve", json=action)).status_code == 404
    other_id, _ = await proposal(sessions, user.id)
    assert (await client.post(f"/runs/{other_id}/approve", json=action)).status_code == 404
    assert (
        await client.post(f"/runs/{run_id}/approve", json={**action, "approval_id": str(uuid4())})
    ).status_code == 404
    assert (await client.post(f"/runs/{run_id}/approve", json=action)).status_code == 409
    for reason in [None, "", " \n\t ", "bad\x00reason", "x" * 2001]:
        response = await client.post(
            f"/runs/{other_id}/approve", json={**action, "decision": "reject", "reason": reason}
        )
        assert response.status_code == 422


@pytest.mark.parametrize("status", ["queued", "awaiting_approval"])
async def test_stop_cancels_parked_work_and_pending_approval_once(
    sessions: async_sessionmaker[AsyncSession], client: AsyncClient, user: User, status: str
) -> None:
    run_id, approval_id = await proposal(sessions, user.id, status)
    responses = await asyncio.gather(*(client.post(f"/runs/{run_id}/stop") for _ in range(3)))
    assert all(response.status_code == 200 and response.json()["status"] == "cancelled" for response in responses)
    action = {"approval_id": str(approval_id), "decision": "approve"}
    assert (await client.post(f"/runs/{run_id}/approve", json=action)).status_code == 409
    async with sessions() as session:
        snapshot = await get_snapshot(session, run_id)
    assert snapshot is not None
    assert snapshot.approvals[0].status == "cancelled"
    assert snapshot.pending_approval is None
    assert snapshot.messages[1].tool_calls[0].result is not None
    assert [event.type for event in snapshot.events].count("run.cancelled") == 1
    assert [event.type for event in snapshot.events].count("approval.decided") == 1
    assert snapshot.messages[-1].role == "tool"


async def test_running_stop_signals_worker_and_terminal_stop_is_noop(
    sessions: async_sessionmaker[AsyncSession], client: AsyncClient, user: User
) -> None:
    run_id, _ = await proposal(sessions, user.id, "running")
    for _ in range(2):
        response = await client.post(f"/runs/{run_id}/stop")
        assert response.status_code == 200 and response.json()["status"] == "cancelling"
    async with sessions.begin() as session:
        run = await session.get_one(Run, run_id)
        assert run.cancellation_requested is True
        call = await session.scalar(select(ToolCall).where(ToolCall.run_id == run_id))
        assert call is not None and call.result is None
        run.status = "completed"
    assert (await client.post(f"/runs/{run_id}/stop")).json()["status"] == "completed"
    assert (await client.post(f"/runs/{uuid4()}/stop")).status_code == 404
