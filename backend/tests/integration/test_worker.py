import asyncio
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager, suppress
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent.contracts import FakeProvider, LLMProvider, ModelEvent, ModelEventType, ProviderMessage, ToolDefinition
from app.agent.worker import WORKER_LOCK, run_worker
from app.models import Message, ModelCall, Run, ToolCall
from app.runs.schemas import EventType, RunSnapshot, RunStatus
from app.runs.service import create_run, get_snapshot

type Sessions = async_sessionmaker[AsyncSession]


@asynccontextmanager
async def worker(sessions: Sessions, resolve: Callable[[str, str], tuple[LLMProvider, None]]) -> AsyncIterator[None]:
    task = asyncio.create_task(run_worker(sessions.kw["bind"], sessions, resolve, poll_interval=0.02))
    try:
        yield
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


async def wait_status(sessions: Sessions, run_id: UUID, status: RunStatus) -> RunSnapshot:
    async with asyncio.timeout(5):
        async with sessions() as reader:
            while True:
                snapshot = await get_snapshot(reader, run_id)
                assert snapshot
                if snapshot.status == status:
                    return snapshot
                await asyncio.sleep(0.01)


async def test_leader_preserves_live_work_and_drains_oldest_first(sessions: Sessions) -> None:
    entered = asyncio.Event()
    release = asyncio.Event()
    provider_names: list[tuple[str, str]] = []

    class PausingFake(FakeProvider):
        async def stream_turn(
            self, messages: list[ProviderMessage], tool_definitions: list[ToolDefinition]
        ) -> AsyncIterator[ModelEvent]:
            entered.set()
            await release.wait()
            yield ModelEvent(type=ModelEventType.text_delta, text="Done")
            yield ModelEvent(type=ModelEventType.turn_complete)

    def resolve(name: str, model: str) -> tuple[LLMProvider, None]:
        provider_names.append((name, model))
        return PausingFake(), None

    async with sessions() as session:
        first = await create_run(session, "First goal")
        second = await create_run(session, "Second goal")
        async with session.begin():
            for run_id, model in [(first.id, "first-model"), (second.id, "second-model")]:
                run = await session.get_one(Run, run_id)
                run.provider, run.model = "fake", model

    async with worker(sessions, resolve):
        await asyncio.wait_for(entered.wait(), 5)
        async with worker(sessions, resolve):
            await asyncio.sleep(0.1)
            await wait_status(sessions, first.id, RunStatus.running)
            await wait_status(sessions, second.id, RunStatus.queued)
            assert provider_names == [("fake", "first-model")]
            release.set()
            await wait_status(sessions, first.id, RunStatus.completed)
            snapshot = await wait_status(sessions, second.id, RunStatus.completed)
            assert [e.type for e in snapshot.events].count(EventType.run_started) == 1
    assert provider_names == [("fake", "first-model"), ("fake", "second-model")]


async def test_recovery_preserves_trace_and_pending_approval(sessions: Sessions) -> None:
    async with sessions() as session:
        active = await create_run(session, "Running at crash")
        stopping = await create_run(session, "Stopping at crash")
        paused = await create_run(session, "Waiting for approval")
        async with session.begin():
            for run_id, status in [
                (active.id, RunStatus.running),
                (stopping.id, RunStatus.cancelling),
                (paused.id, RunStatus.awaiting_approval),
            ]:
                (await session.get_one(Run, run_id)).status = status
            attempt = ModelCall(run_id=active.id, status="running", model="fake")
            assistant = Message(run_id=active.id, index=1, role="assistant", status="running", text="Partial")
            session.add_all([attempt, assistant])
            await session.flush()
            call = ToolCall(
                run_id=active.id, message_id=assistant.id, provider_call_id="pending", name="date_math", arguments={}
            )
            session.add(call)

    def unused(name: str, model: str) -> tuple[LLMProvider, None]:
        pytest.fail("Recovery should not invoke a provider")

    async with worker(sessions, unused):
        failed = await wait_status(sessions, active.id, RunStatus.failed)
        cancelled = await wait_status(sessions, stopping.id, RunStatus.cancelled)
        waiting = await wait_status(sessions, paused.id, RunStatus.awaiting_approval)
        assert failed.events[-1].payload["code"] == "PROCESS_RESTARTED"
        assert cancelled.events[-1].type == EventType.run_cancelled
        assert waiting.snapshot_cursor == 1
    async with sessions() as reader:
        interrupted = await reader.get_one(ModelCall, attempt.id)
        assert interrupted.status == "failed" and interrupted.completed_at is not None
        assert not interrupted.usage_complete and interrupted.input_tokens is None
        partial = await reader.get_one(Message, assistant.id)
        assert (partial.text, partial.status) == ("Partial", "failed")
        assert (await reader.get_one(ToolCall, call.id)).result is not None


async def test_provider_resolution_failure_is_sanitized(sessions: Sessions, caplog: pytest.LogCaptureFixture) -> None:
    async with sessions() as session:
        run = await create_run(session, "Check failure")

    def broken(name: str, model: str) -> tuple[LLMProvider, None]:
        raise ValueError("private provider configuration")

    async with worker(sessions, broken):
        failed = await wait_status(sessions, run.id, RunStatus.failed)
    assert [e.type for e in failed.events] == [EventType.run_queued, EventType.run_started, EventType.run_failed]
    assert "private provider configuration" not in failed.model_dump_json() + caplog.text


async def test_lost_owner_stops_stream_before_queue_recovers(sessions: Sessions) -> None:
    streaming = asyncio.Event()
    closed = asyncio.Event()

    class WaitingFake(FakeProvider):
        async def stream_turn(
            self, messages: list[ProviderMessage], tool_definitions: list[ToolDefinition]
        ) -> AsyncIterator[ModelEvent]:
            streaming.set()
            try:
                await asyncio.Future[None]()
                yield ModelEvent(ModelEventType.turn_complete)
            finally:
                closed.set()

    async with sessions() as session:
        interrupted = await create_run(session, "Interrupted by database connection loss")
        next_run = await create_run(session, "Continue queue processing")

    scripted = FakeProvider(
        [[ModelEvent(ModelEventType.text_delta, text="Done"), ModelEvent(ModelEventType.turn_complete)]]
    )
    providers = iter([WaitingFake(), scripted])

    def resolve(name: str, model: str) -> tuple[LLMProvider, None]:
        return next(providers), None

    async with worker(sessions, resolve):
        await asyncio.wait_for(streaming.wait(), 5)
        # This fixture owns the disposable database. Target only its worker's granted advisory lock.
        async with sessions.begin() as admin:
            terminated = await admin.scalar(
                text("""
                SELECT pg_terminate_backend(pid) FROM pg_locks
                WHERE locktype = 'advisory' AND granted
                  AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
                  AND classid = :high AND objid = :low AND objsubid = 1
            """),
                {"high": WORKER_LOCK >> 32, "low": WORKER_LOCK & 0xFFFFFFFF},
            )
            assert terminated
        await asyncio.wait_for(closed.wait(), 5)
        failed = await wait_status(sessions, interrupted.id, RunStatus.failed)
        assert failed.events[-1].payload["code"] == "PROCESS_RESTARTED"
        await wait_status(sessions, next_run.id, RunStatus.completed)
