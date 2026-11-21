"""Approval checkpoints survive worker changes without repeating model turns or budgets."""

import asyncio
import json
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent.contracts import FakeProvider, ModelEvent, ModelEventType
from app.agent.loop import execute_run
from app.agent.worker import claim, recover
from app.models import Approval, Order, Refund, Run
from app.runs.decisions import decide_approval
from app.runs.schemas import ApprovalAction, ApprovalDecision
from app.runs.service import create_run, get_snapshot

type Sessions = async_sessionmaker[AsyncSession]
END = ModelEvent(ModelEventType.turn_complete)
ANSWER = ModelEvent(ModelEventType.text_delta, text="Reviewed.")


async def prepared(sessions: Sessions, **limits: int) -> UUID:
    async with sessions() as session:
        created = await create_run(session, "Review and refund the late shipment")
        async with session.begin():
            run = await session.get_one(Run, created.id)
            run.status = "running"
            for key, value in limits.items():
                setattr(run, key, value)
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
    return created.id


def refund(call_id: str = "refund") -> ModelEvent:
    return ModelEvent(
        ModelEventType.tool_call,
        call_id=call_id,
        tool_name="issue_refund",
        arguments={"order_id": "late", "reason": "Shipment was late"},
    )


async def decide(sessions: Sessions, run_id: UUID, approved: bool) -> None:
    async with sessions() as session:
        approval_id = (
            await session.scalars(select(Approval.id).where(Approval.run_id == run_id, Approval.status == "pending"))
        ).one()
    async with sessions() as session:
        await decide_approval(
            session,
            run_id,
            ApprovalAction(
                approval_id=approval_id,
                decision=ApprovalDecision.approve if approved else ApprovalDecision.reject,
                reason=None if approved else "Customer requested no adjustment",
            ),
        )
    claimed = await claim(sessions)
    assert claimed is not None and claimed[0] == run_id


@pytest.mark.parametrize("approved", [True, False])
async def test_pause_restart_resumes_remaining_batch_and_exact_transcript(sessions: Sessions, approved: bool) -> None:
    run_id = await prepared(sessions)
    malformed = ModelEvent(
        ModelEventType.tool_call,
        call_id="broken",
        tool_name="date_math",
        raw_arguments='{"operation":',
        error_message="Invalid JSON arguments",
    )
    first = FakeProvider([[refund(), malformed, END]])
    await execute_run(sessions, run_id, first)
    async with sessions() as session:
        paused = await get_snapshot(session, run_id)
        assert paused and paused.status == "awaiting_approval"
        assert (paused.step_count, paused.tool_call_count) == (1, 1)
        assert len(paused.approvals) == 1 and len(paused.messages) == 2
        assert await session.scalar(select(func.count()).select_from(Refund)) == 0
        elapsed = paused.active_elapsed_ms
    await recover(sessions)
    await decide(sessions, run_id, approved)
    resumed = FakeProvider([[ANSWER, END]])
    await execute_run(sessions, run_id, resumed)
    async with sessions() as session:
        done = await get_snapshot(session, run_id)
        assert done and done.status == "completed"
        assert (done.step_count, done.tool_call_count) == (2, 2)
        assert done.active_elapsed_ms >= elapsed
        assert await session.scalar(select(func.count()).select_from(Refund)) == int(approved)
        assert [m.role for m in done.messages] == ["user", "assistant", "tool", "tool", "assistant"]
    history = resumed.received_messages[0]
    assistant = next(m for m in history if m.role == "assistant")
    assert assistant.tool_calls[1]["function"]["arguments"] == malformed.raw_arguments
    observations = [m for m in history if m.role == "tool"]
    assert [m.tool_call_id for m in observations] == ["refund", "broken"]
    assert json.loads(observations[0].content)["ok"] == approved
    if not approved:
        assert json.loads(observations[0].content)["error"] == {
            "code": "APPROVAL_REJECTED",
            "message": "Customer requested no adjustment",
        }
    assert json.loads(observations[1].content)["error"]["code"] == "INVALID_ARGUMENTS"
    assert first.call_index == resumed.call_index == 1


async def test_resume_does_not_reset_step_or_tool_budget(sessions: Sessions) -> None:
    run_id = await prepared(sessions, max_agent_steps=1, max_tool_calls=1)
    await execute_run(sessions, run_id, FakeProvider([[refund(), END]]))
    await decide(sessions, run_id, True)
    unused = FakeProvider([[ANSWER, END]])
    await execute_run(sessions, run_id, unused)
    async with sessions() as session:
        trace = await get_snapshot(session, run_id)
        assert trace and trace.status == "failed"
        assert (trace.step_count, trace.tool_call_count, unused.call_index) == (1, 1, 0)
        assert trace.events[-1].payload["code"] == "MAX_AGENT_STEPS"
        assert await session.scalar(select(func.count()).select_from(Refund)) == 1


async def test_approved_refund_order_lock_wait_obeys_active_deadline(sessions: Sessions) -> None:
    run_id = await prepared(sessions)
    await execute_run(sessions, run_id, FakeProvider([[refund(), END]]))
    await decide(sessions, run_id, True)
    async with sessions.begin() as session:
        run = await session.get_one(Run, run_id)
        run.max_active_run_seconds = 1
        run.active_elapsed_ms = 700
    unused = FakeProvider([[ANSWER, END]])
    async with sessions.begin() as locker:
        await locker.get_one(Order, "late", with_for_update=True)
        # Keep the order locked until execution has finished. A missing timeout hangs here.
        await asyncio.wait_for(execute_run(sessions, run_id, unused), 3)
    async with sessions() as session:
        trace = await get_snapshot(session, run_id)
        assert trace and trace.status == "failed"
        assert trace.events[-1].payload["code"] == "MAX_ACTIVE_RUN_SECONDS"
        assert trace.messages[-1].role == "tool"
        assert json.loads(trace.messages[-1].text)["error"]["code"] == "MAX_ACTIVE_RUN_SECONDS"
        assert await session.scalar(select(func.count()).select_from(Refund)) == 0
        assert unused.call_index == 0


async def test_duplicate_provider_call_id_after_resume_fails_without_repeating_refund(sessions: Sessions) -> None:
    run_id = await prepared(sessions)
    await execute_run(sessions, run_id, FakeProvider([[refund(), END]]))
    await decide(sessions, run_id, True)
    await execute_run(sessions, run_id, FakeProvider([[refund(), END]]))
    async with sessions() as session:
        trace = await get_snapshot(session, run_id)
        assert trace and trace.status == "failed"
        assert trace.events[-1].payload["code"] == "MODEL_ERROR"
        assert (trace.step_count, trace.tool_call_count) == (2, 1)
        assert len(trace.approvals) == 1
        assert await session.scalar(select(func.count()).select_from(Refund)) == 1
