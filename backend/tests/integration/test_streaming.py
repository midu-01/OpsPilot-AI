"""Integration tests for the live WebSocket stream on a real Uvicorn server: events arrive while the model is still
working, reconnecting replays only what was missed, subscribers never run the agent, commands stay HTTP, and signing
out ends an open stream."""

import asyncio
import json
from collections.abc import AsyncIterator
from uuid import UUID

import httpx
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent.contracts import ModelEvent, ModelEventType, ProviderMessage, ToolDefinition
from app.agent.loop import execute_run
from app.models import Run, User
from app.runs.events import get_broker
from app.runs.schemas import EventType, RunEvent, RunStatus
from app.runs.service import create_run, get_snapshot
from tests.integration.stream_client import READY, open_stream, read_until_closed

type Sessions = async_sessionmaker[AsyncSession]


class ControllableProvider:
    """Emits an early text delta, pauses until unblocked, then finishes."""

    def __init__(self, pause_event: asyncio.Event, first_emitted: asyncio.Event) -> None:
        self.pause_event = pause_event
        self.first_emitted = first_emitted
        self.call_count = 0

    async def stream_turn(
        self, messages: list[ProviderMessage], tools: list[ToolDefinition]
    ) -> AsyncIterator[ModelEvent]:
        self.call_count += 1
        yield ModelEvent(ModelEventType.text_delta, text="Early incremental progress")
        self.first_emitted.set()
        await self.pause_event.wait()
        yield ModelEvent(ModelEventType.turn_complete)


async def running_run(sessions: Sessions, user: User, goal: str) -> UUID:
    """A run the tests execute themselves, already marked running as the worker would."""
    async with sessions() as session:
        created = await create_run(session, user.id, goal)
        async with session.begin():
            run = await session.get_one(Run, created.id)
            run.status = "running"
    return created.id


async def subscriptions_released(run_id: UUID) -> bool:
    """The server releases a stream's subscription once it closes; give its handler a moment to finish."""
    for _ in range(50):
        if run_id not in get_broker()._subscribers:
            return True
        await asyncio.sleep(0.02)
    return False


async def test_streaming_early_event_before_finish_and_reconnect(
    sessions: Sessions, server: str, user: User, user_headers: dict[str, str]
) -> None:
    """A complete event message arrives while the provider is still blocked, and reconnects replay only the rest."""
    pause_event = asyncio.Event()
    first_emitted = asyncio.Event()
    provider = ControllableProvider(pause_event, first_emitted)
    run_id = await running_run(sessions, user, "Stream live progress")

    worker_task = asyncio.create_task(execute_run(sessions, run_id, provider))

    events: list[RunEvent] = []
    early_event_received = False
    async with open_stream(server, run_id, user_headers) as stream:
        assert json.loads(await stream.recv()) == READY
        async with asyncio.timeout(10):
            async for raw in stream:  # the server closes the socket after the terminal event
                message = json.loads(raw)
                if message["type"] == "stream.keepalive":
                    continue
                event = RunEvent.model_validate(message)
                events.append(event)
                # Only the first match is the live delta: message.completed repeats the same text later.
                if not early_event_received and event.type == EventType.message_delta:
                    assert "Early incremental progress" in raw
                    early_event_received = True
                    # Provider MUST still be blocked!
                    assert not pause_event.is_set()
                    assert first_emitted.is_set()
                    # Now unblock provider to let it finish
                    pause_event.set()
        assert (stream.close_code, stream.close_reason) == (1000, "Run finished")

    assert early_event_received
    sequences = [event.sequence for event in events]
    assert sequences == list(range(1, len(events) + 1))  # every event once, in order, from the first
    assert events[-1].type == EventType.run_completed
    await asyncio.wait_for(worker_task, timeout=2.0)

    # Reconnecting after the next-to-last event replays only the last one.
    async with open_stream(server, run_id, user_headers, after=sequences[-2]) as replay:
        replayed = await read_until_closed(replay)
    assert replayed.messages[0] == READY
    assert [event.sequence for event in replayed.events] == [sequences[-1]]
    assert replayed.events[0].type == EventType.run_completed
    assert replayed.close_code == 1000

    # With every event already applied there is nothing to stream: the socket closes at once.
    async with open_stream(server, run_id, user_headers, after=sequences[-1]) as caught_up:
        nothing = await read_until_closed(caught_up)
    assert nothing.messages == []
    assert (nothing.close_code, nothing.close_reason) == (1000, "Run finished")


async def test_two_subscribers_and_disconnect_no_duplicate_execution(
    sessions: Sessions, server: str, user: User, user_headers: dict[str, str]
) -> None:
    """Two subscribers stream the same run without running it twice, and one leaving does not cancel it."""
    pause_event = asyncio.Event()
    first_emitted = asyncio.Event()
    provider = ControllableProvider(pause_event, first_emitted)
    run_id = await running_run(sessions, user, "Two subscribers")

    worker_task = asyncio.create_task(execute_run(sessions, run_id, provider))
    await asyncio.wait_for(first_emitted.wait(), timeout=5.0)

    async with open_stream(server, run_id, user_headers) as staying:
        async with open_stream(server, run_id, user_headers) as leaving:
            assert json.loads(await leaving.recv()) == READY
            assert json.loads(await staying.recv()) == READY
        # The first subscriber has left. Release the provider: the run goes on, and the other subscriber sees it end.
        pause_event.set()
        await asyncio.wait_for(worker_task, timeout=2.0)
        received = await read_until_closed(staying)

    assert received.events[-1].type == EventType.run_completed
    assert received.close_code == 1000
    assert provider.call_count == 1  # streaming never executes the agent

    # The subscriber that left reconnects and gets only what it missed.
    last_seq = received.events[-1].sequence
    async with open_stream(server, run_id, user_headers, after=last_seq - 1) as reconnected:
        resumed = await read_until_closed(reconnected)
    assert [event.sequence for event in resumed.events] == [last_seq]
    assert await subscriptions_released(run_id)


async def test_stop_and_approval_are_independent_commands(
    sessions: Sessions, server: str, user: User, user_headers: dict[str, str]
) -> None:
    """Commands stay HTTP POSTs next to the open stream, and the stream delivers their effects."""
    async with sessions() as session:
        created = await create_run(session, user.id, "Stop and stream test")
    run_id = created.id

    async with (
        open_stream(server, run_id, user_headers) as stream,
        httpx.AsyncClient(base_url=server, timeout=10.0, headers=user_headers) as client,
    ):
        assert json.loads(await stream.recv()) == READY

        # Subscribing must not start or resume the run.
        async with sessions() as session:
            snapshot = await get_snapshot(session, run_id)
            assert snapshot and snapshot.status == RunStatus.queued

        stop_resp = await client.post(f"/runs/{run_id}/stop")
        assert stop_resp.status_code == 200

        # The stream delivers run.cancelled, then the server closes it.
        received = await read_until_closed(stream)

    assert [event.type for event in received.events] == [EventType.run_queued, EventType.run_cancelled]
    assert received.close_code == 1000

    # Reconnecting once the terminal event was consumed closes at once.
    async with open_stream(server, run_id, user_headers, after=received.events[-1].sequence) as again:
        assert (await read_until_closed(again)).messages == []


async def test_signing_out_ends_an_open_stream(
    sessions: Sessions, server: str, user: User, user_headers: dict[str, str]
) -> None:
    """A revoked token closes the stream with 4401 at its next wake-up, and reconnecting with it is refused."""
    async with sessions() as session:
        created = await create_run(session, user.id, "Watch until sign-out")

    async with open_stream(server, created.id, user_headers) as stream:
        assert json.loads(await stream.recv()) == READY
        assert RunEvent.model_validate_json(await stream.recv()).type == EventType.run_queued

        async with httpx.AsyncClient(base_url=server, timeout=10.0, headers=user_headers) as client:
            assert (await client.post("/auth/logout")).status_code == 204
        # Wake the stream now rather than waiting up to 15 s for its keepalive; either way it re-checks the sign-in.
        get_broker().notify(created.id)
        # read_until_closed gives up after 10 s, less than the keepalive: this passes only if the server closed it.
        rest = await read_until_closed(stream)

    assert rest.messages == []
    assert (rest.close_code, rest.close_reason) == (4401, "Not authenticated")

    async with open_stream(server, created.id, user_headers) as again:
        refused = await read_until_closed(again)
    assert refused.messages == []  # not even "ready"
    assert (refused.close_code, refused.close_reason) == (4401, "Not authenticated")
