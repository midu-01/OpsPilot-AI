"""Integration tests for live SSE streaming, replay, reconnect, and runner independence."""

import asyncio
import socket
from collections.abc import AsyncIterator

import httpx
import pytest
import uvicorn
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent.contracts import ModelEvent, ModelEventType, ProviderMessage, ToolDefinition
from app.agent.loop import execute_run
from app.db import get_session, get_session_factory
from app.main import app
from app.models import Run, User
from app.runs.events import get_broker
from app.runs.schemas import EventType, RunEvent, RunStatus
from app.runs.service import create_run, get_snapshot

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


def get_ephemeral_port() -> int:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        return port
    except PermissionError as exc:
        pytest.skip(f"Socket bind is restricted by environment sandbox: {exc}")


@pytest.fixture
async def server(sessions: Sessions) -> AsyncIterator[str]:
    """Run a real Uvicorn server on a loopback ephemeral port."""
    port = get_ephemeral_port()

    app.dependency_overrides[get_session_factory] = lambda: sessions

    async def isolated_session() -> AsyncIterator[AsyncSession]:
        async with sessions() as session:
            yield session

    app.dependency_overrides[get_session] = isolated_session

    config = uvicorn.Config(
        app=app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
    )
    srv = uvicorn.Server(config)
    server_task = asyncio.create_task(srv.serve())

    # Wait for server to bind
    for _ in range(50):
        if srv.started:
            break
        await asyncio.sleep(0.05)
    else:
        server_task.cancel()
        raise RuntimeError("Uvicorn failed to start")

    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        srv.should_exit = True
        await asyncio.gather(server_task, return_exceptions=True)
        app.dependency_overrides.pop(get_session, None)
        app.dependency_overrides.pop(get_session_factory, None)


def parse_sse_events(lines: list[str]) -> list[RunEvent]:
    """Parse raw SSE lines into typed RunEvents."""
    events: list[RunEvent] = []
    current_data: str | None = None
    for line in lines:
        if line.startswith("data: "):
            current_data = line[len("data: ") :]
        elif line == "" and current_data:
            events.append(RunEvent.model_validate_json(current_data))
            current_data = None
    return events


async def test_streaming_early_event_before_finish_and_reconnect(
    sessions: Sessions, server: str, user: User, user_headers: dict[str, str]
) -> None:
    """Assert a complete SSE frame arrives while the provider is still blocked on a real HTTP server."""
    pause_event = asyncio.Event()
    first_emitted = asyncio.Event()
    provider = ControllableProvider(pause_event, first_emitted)

    async with sessions() as session:
        created = await create_run(session, user.id, "Stream live progress")
        run_id = created.id
        async with session.begin():
            run = await session.get_one(Run, run_id)
            run.status = "running"

    # Start execution in the background
    worker_task = asyncio.create_task(execute_run(sessions, run_id, provider))

    async with httpx.AsyncClient(base_url=server, timeout=10.0, headers=user_headers) as client:
        # Connect to stream while provider is blocked
        async with client.stream("GET", f"/runs/{run_id}/stream") as response:
            assert response.status_code == 200
            assert "text/event-stream" in response.headers["content-type"]
            assert response.headers["cache-control"] == "no-cache, no-transform"

            received_lines: list[str] = []
            early_event_received = False

            # The server closes the stream after the terminal frame, so this loop ends on its own.
            async for line in response.aiter_lines():
                received_lines.append(line)
                # Only the first match is the live delta: message.completed repeats the same text later.
                if not early_event_received and line.startswith("data: ") and "Early incremental progress" in line:
                    early_event_received = True
                    # Provider MUST still be blocked!
                    assert not pause_event.is_set()
                    assert first_emitted.is_set()
                    # Now unblock provider to let it finish
                    pause_event.set()

            assert early_event_received
            events = parse_sse_events(received_lines)
            assert len(events) >= 3
            # Check strict sequence ordering
            sequences = [e.sequence for e in events]
            assert sequences == sorted(sequences)
            assert sequences == list(range(1, len(events) + 1))

            # Terminal event delivered
            assert events[-1].type == EventType.run_completed

        await asyncio.wait_for(worker_task, timeout=2.0)

        # Test Reconnect with Last-Event-ID
        async with client.stream(
            "GET", f"/runs/{run_id}/stream", headers={"Last-Event-ID": str(sequences[-2])}
        ) as replay_response:
            assert replay_response.status_code == 200
            replay_lines = [line async for line in replay_response.aiter_lines()]
            replayed = parse_sse_events(replay_lines)
            assert len(replayed) == 1
            assert replayed[0].sequence == sequences[-1]
            assert replayed[0].type == EventType.run_completed

        # Test Reconnect with ?after=N
        async with client.stream("GET", f"/runs/{run_id}/stream?after={sequences[-2]}") as replay_after:
            assert replay_after.status_code == 200
            replay_after_lines = [line async for line in replay_after.aiter_lines()]
            replayed_after = parse_sse_events(replay_after_lines)
            assert len(replayed_after) == 1
            assert replayed_after[0].sequence == sequences[-1]

        # Test Header Precedence: Last-Event-ID takes precedence over ?after
        async with client.stream(
            "GET", f"/runs/{run_id}/stream?after=0", headers={"Last-Event-ID": str(sequences[-1])}
        ) as precedence_resp:
            # All events consumed -> 204
            assert precedence_resp.status_code == 204


async def test_two_subscribers_and_disconnect_no_duplicate_execution(
    sessions: Sessions, server: str, user: User, user_headers: dict[str, str]
) -> None:
    """Assert two subscribers can stream the same run without duplicate execution, and disconnect does not cancel."""
    pause_event = asyncio.Event()
    first_emitted = asyncio.Event()
    provider = ControllableProvider(pause_event, first_emitted)

    async with sessions() as session:
        created = await create_run(session, user.id, "Two subscribers")
        run_id = created.id
        async with session.begin():
            run = await session.get_one(Run, run_id)
            run.status = "running"

    worker_task = asyncio.create_task(execute_run(sessions, run_id, provider))
    await asyncio.wait_for(first_emitted.wait(), timeout=5.0)

    async with httpx.AsyncClient(base_url=server, timeout=10.0, headers=user_headers) as client:
        # Start subscriber 1
        sub1_stream = client.stream("GET", f"/runs/{run_id}/stream")
        resp1 = await sub1_stream.__aenter__()
        assert resp1.status_code == 200

        # Start subscriber 2
        sub2_stream = client.stream("GET", f"/runs/{run_id}/stream")
        resp2 = await sub2_stream.__aenter__()
        assert resp2.status_code == 200

        # Disconnect subscriber 1 by exiting its context
        await sub1_stream.__aexit__(None, None, None)

        # Release provider
        pause_event.set()
        await asyncio.wait_for(worker_task, timeout=2.0)

        # Subscriber 2 should still receive terminal event; the server closes the stream after it
        sub2_lines = [line async for line in resp2.aiter_lines()]
        await sub2_stream.__aexit__(None, None, None)

        events2 = parse_sse_events(sub2_lines)
        assert any(e.type == EventType.run_completed for e in events2)

        # Ensure only 1 model call occurred
        assert provider.call_count == 1

        # Reconnect subscriber 1 and verify it gets missing suffix
        last_seq = events2[-1].sequence
        async with client.stream(
            "GET", f"/runs/{run_id}/stream", headers={"Last-Event-ID": str(last_seq - 1)}
        ) as sub1_recon:
            assert sub1_recon.status_code == 200
            reconnected_events = parse_sse_events([line async for line in sub1_recon.aiter_lines()])
            assert len(reconnected_events) == 1
            assert reconnected_events[0].sequence == last_seq


async def test_stop_and_approval_are_independent_commands(
    sessions: Sessions, server: str, user: User, user_headers: dict[str, str]
) -> None:
    """Confirm stop and approval endpoints work as separate HTTP commands independently of SSE stream."""
    async with sessions() as session:
        created = await create_run(session, user.id, "Stop and stream test")
        run_id = created.id
        async with session.begin():
            run = await session.get_one(Run, run_id)
            run.status = "queued"

    async with httpx.AsyncClient(base_url=server, timeout=10.0, headers=user_headers) as client:
        # Connecting to stream must not start or resume the run
        async with client.stream("GET", f"/runs/{run_id}/stream") as stream:
            assert stream.status_code == 200

            # Verify run is STILL queued
            async with sessions() as session:
                snapshot = await get_snapshot(session, run_id)
                assert snapshot and snapshot.status == RunStatus.queued

            # Now issue Stop command via POST /runs/{id}/stop
            stop_resp = await client.post(f"/runs/{run_id}/stop")
            assert stop_resp.status_code == 200

            # Stream receives run_cancelled terminal event; the server closes the stream after it
            lines = [line async for line in stream.aiter_lines()]

            events = parse_sse_events(lines)
            assert any(e.type == EventType.run_cancelled for e in events)

        # Reconnection after terminal consumed returns 204
        last_seq = events[-1].sequence
        recon = await client.get(f"/runs/{run_id}/stream", headers={"Last-Event-ID": str(last_seq)})
        assert recon.status_code == 204


async def test_signing_out_ends_an_open_stream(
    sessions: Sessions, server: str, user: User, user_headers: dict[str, str]
) -> None:
    """A revoked token stops the stream at its next wake-up, and reconnecting with it is refused."""
    async with sessions() as session:
        created = await create_run(session, user.id, "Watch until sign-out")

    async with httpx.AsyncClient(base_url=server, timeout=10.0, headers=user_headers) as client:
        async with client.stream("GET", f"/runs/{created.id}/stream") as stream:
            assert stream.status_code == 200
            lines = stream.aiter_lines()
            first_frame: list[str] = []
            async for line in lines:
                first_frame.append(line)
                if line == "":  # a blank line ends an SSE frame
                    break
            assert [event.type for event in parse_sse_events(first_frame)] == [EventType.run_queued]

            assert (await client.post("/auth/logout")).status_code == 204
            # Wake the stream now rather than waiting up to 15 s for its keepalive; either way it re-checks the token.
            get_broker().notify(created.id)
            # The read timeout (10 s) is shorter than the keepalive, so this only finishes if the server closed it.
            rest = [line async for line in lines]

        assert parse_sse_events(rest) == []
        assert (await client.get(f"/runs/{created.id}/stream")).status_code == 401
