"""Stop cancels silent provider I/O and wins over subsequent execution writes."""

import asyncio
from collections.abc import AsyncIterator
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent.contracts import FakeProvider, ModelEvent, ModelEventType, ProviderMessage, ToolDefinition
from app.agent.loop import execute_run
from app.models import Message, ModelCall, Order, Refund, Run
from app.runs.schemas import EventType
from app.runs.service import create_run, get_snapshot
from tests.integration.test_approvals import ANSWER, END, decide, prepared, refund

type Sessions = async_sessionmaker[AsyncSession]


async def stop(sessions: Sessions, run_id: UUID) -> None:
    async with sessions.begin() as session:
        run = await session.get_one(Run, run_id, with_for_update=True)
        run.cancellation_requested = True
        run.status = "cancelling"


async def test_stop_cancels_silent_stream_and_closes_trace(sessions: Sessions) -> None:
    entered, closed = asyncio.Event(), asyncio.Event()

    class SilentProvider:
        async def stream_turn(
            self, messages: list[ProviderMessage], tools: list[ToolDefinition]
        ) -> AsyncIterator[ModelEvent]:
            try:
                yield ModelEvent(ModelEventType.text_delta, text="Partial")
                entered.set()
                await asyncio.Event().wait()
            finally:
                closed.set()

    async with sessions() as session:
        created = await create_run(session, "Wait for cancellation")
        async with session.begin():
            (await session.get_one(Run, created.id)).status = "running"
    task = asyncio.create_task(execute_run(sessions, created.id, SilentProvider()))
    await asyncio.wait_for(entered.wait(), 5)
    await stop(sessions, created.id)
    await asyncio.wait_for(task, 2)
    assert closed.is_set()
    async with sessions() as session:
        trace = await get_snapshot(session, created.id)
        assert trace and trace.status == "cancelled"
        assert trace.messages[-1].text == "Partial"
        assert (await session.get_one(Message, trace.messages[-1].id)).status == "failed"
        assert trace.events[-1].type == EventType.run_cancelled
        assert not await session.scalar(select(ModelCall.id).where(ModelCall.status == "running"))


async def test_stop_lock_wins_before_approved_refund_write(sessions: Sessions) -> None:
    run_id = await prepared(sessions)
    await execute_run(sessions, run_id, FakeProvider([[refund(), END]]))
    await decide(sessions, run_id, True)
    async with sessions.begin() as stopper:
        run = await stopper.get_one(Run, run_id, with_for_update=True)
        task = asyncio.create_task(execute_run(sessions, run_id, FakeProvider([[ANSWER, END]])))
        await asyncio.sleep(0.05)
        run.cancellation_requested = True
        run.status = "cancelling"
    await asyncio.wait_for(task, 2)
    async with sessions() as session:
        trace = await get_snapshot(session, run_id)
        assert await session.scalar(select(func.count()).select_from(Refund)) == 0
        assert trace and trace.status == "cancelled"
        assert not any(event.type == EventType.tool_completed for event in trace.events)


async def test_committed_refund_survives_stop_during_followup(sessions: Sessions) -> None:
    run_id = await prepared(sessions)
    await execute_run(sessions, run_id, FakeProvider([[refund(), END]]))
    await decide(sessions, run_id, True)
    entered = asyncio.Event()

    class Followup:
        async def stream_turn(
            self, messages: list[ProviderMessage], tools: list[ToolDefinition]
        ) -> AsyncIterator[ModelEvent]:
            entered.set()
            await asyncio.Event().wait()
            yield END

    task = asyncio.create_task(execute_run(sessions, run_id, Followup()))
    await asyncio.wait_for(entered.wait(), 5)
    await stop(sessions, run_id)
    await asyncio.wait_for(task, 2)
    async with sessions() as session:
        trace = await get_snapshot(session, run_id)
        assert await session.scalar(select(func.count()).select_from(Refund)) == 1
        assert trace and trace.status == "cancelled"
        assert sum(e.type == EventType.tool_completed for e in trace.events) == 1


async def test_order_lock_timeout_rolls_back_approved_refund(sessions: Sessions) -> None:
    run_id = await prepared(sessions, max_active_run_seconds=1)
    await execute_run(sessions, run_id, FakeProvider([[refund(), END]]))
    await decide(sessions, run_id, True)
    async with sessions.begin() as locker:
        await locker.get_one(Order, "late", with_for_update=True)
        unused = FakeProvider([[ANSWER, END]])
        # Keep the order lock held throughout the whole remaining budget.
        await asyncio.wait_for(execute_run(sessions, run_id, unused), 4)
    async with sessions() as session:
        trace = await get_snapshot(session, run_id)
        assert trace and trace.status == "failed"
        assert trace.events[-1].payload["code"] == "MAX_ACTIVE_RUN_SECONDS"
        assert await session.scalar(select(func.count()).select_from(Refund)) == 0
        assert unused.call_index == 0
