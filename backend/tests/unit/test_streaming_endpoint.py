"""Unit tests for the run stream: the WebSocket route's checks, messages and close codes, and the subscription loop.

The database is mocked. Sign-in, ownership and live delivery on a real server are covered by integration tests.
"""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

import pytest
from fastapi import WebSocketDisconnect
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_user_lookup
from app.db import get_session
from app.main import app
from app.models import Run, RunEventRecord, User
from app.runs.events import SignedOut, get_broker, stream_events
from app.runs.schemas import EventType, RunEvent, RunStatus, StreamKeepalive

type StreamItem = RunEvent | StreamKeepalive

NOW = datetime.now(UTC)
OWNER = User(id=uuid4(), email="alex@opspilot.test", display_name="Alex Rivera", password_hash="unused")
READY = {"type": "stream.ready"}


class MockDb:
    def __init__(
        self,
        run_id: UUID,
        status: RunStatus,
        next_seq: int,
        events: list[RunEvent] | None = None,
        owner_id: UUID | None = OWNER.id,
    ) -> None:
        self.run_id = run_id
        self.status = status
        self.next_seq = next_seq
        self.events = events or []
        self.owner_id = owner_id


@pytest.fixture
def run_id() -> UUID:
    return uuid4()


def create_mock_app(mock_db: MockDb | None):
    """Serve the run (or no run, for None) and its events from memory instead of PostgreSQL."""

    @asynccontextmanager
    async def mock_session() -> AsyncIterator[AsyncSession]:
        sess = AsyncMock(spec=AsyncSession)

        async def mock_scalar(query, *args, **kwargs):
            if mock_db is None or "FROM runs" not in str(query):
                return None
            return Run(
                id=mock_db.run_id,
                user_id=mock_db.owner_id,
                status=mock_db.status.value,
                next_event_sequence=mock_db.next_seq,
            )

        async def mock_scalars(query, *args, **kwargs):
            params = query.compile().params
            after_seq = params.get("sequence_1", 0)
            return [
                RunEventRecord(
                    run_id=e.run_id,
                    sequence=e.sequence,
                    type=e.type.value,
                    occurred_at=e.occurred_at,
                    payload=e.payload,
                    schema_version=1,
                )
                for e in (mock_db.events if mock_db else [])
                if e.sequence > after_seq
            ]

        sess.scalar = mock_scalar
        sess.scalars = mock_scalars
        yield sess

    app.dependency_overrides[get_session] = mock_session
    return mock_session


def sign_in_as(user: User | None) -> None:
    """Stand in for the bearer-token lookup: every check, now and at each wake-up, finds `user`."""

    async def find_user(session: AsyncSession) -> User | None:
        return user

    app.dependency_overrides[get_user_lookup] = lambda: find_user


@pytest.fixture(autouse=True)
def cleanup_overrides():
    sign_in_as(OWNER)
    yield
    for dependency in (get_session, get_user_lookup):
        app.dependency_overrides.pop(dependency, None)


def receive_until_closed(path: str) -> tuple[list[dict[str, Any]], WebSocketDisconnect]:
    """Every message the server sends on `path`, and how it closed the socket."""
    messages: list[dict[str, Any]] = []
    with TestClient(app).websocket_connect(path) as websocket, pytest.raises(WebSocketDisconnect) as closed:
        while True:
            messages.append(websocket.receive_json())
    return messages, closed.value


def queued_event(run_id: UUID) -> RunEvent:
    return RunEvent(run_id=run_id, sequence=1, type=EventType.run_queued, occurred_at=NOW)


def test_a_caller_without_a_valid_sign_in_is_closed_with_4401(run_id: UUID) -> None:
    create_mock_app(MockDb(run_id=run_id, status=RunStatus.running, next_seq=2, events=[queued_event(run_id)]))
    sign_in_as(None)  # no token, or one that is unknown, expired or revoked

    messages, closed = receive_until_closed(f"/runs/{run_id}/stream")

    assert messages == []  # not even "ready": nothing about the run leaks
    assert (closed.code, closed.reason) == (4401, "Not authenticated")


@pytest.mark.parametrize("owner_id", [uuid4(), None], ids=["another user's run", "a run without an owner"])
def test_a_run_the_caller_does_not_own_is_closed_with_4404(run_id: UUID, owner_id: UUID | None) -> None:
    create_mock_app(MockDb(run_id=run_id, status=RunStatus.running, next_seq=2, owner_id=owner_id))
    messages, closed = receive_until_closed(f"/runs/{run_id}/stream")
    assert messages == []
    assert (closed.code, closed.reason) == (4404, "Run not found")


def test_an_unknown_run_is_closed_with_4404() -> None:
    create_mock_app(None)
    messages, closed = receive_until_closed(f"/runs/{uuid4()}/stream")
    assert messages == []
    assert (closed.code, closed.reason) == (4404, "Run not found")


@pytest.mark.parametrize(
    ("after", "reason"),
    [
        ("invalid", "Invalid event cursor; expected an integer"),
        ("1.5", "Invalid event cursor; expected an integer"),
        ("-1", "Cursor must be non-negative"),
        ("5", "Cursor is ahead of the run's latest sequence"),  # the run's latest sequence is 3
    ],
)
def test_a_malformed_or_future_cursor_is_closed_with_4422(run_id: UUID, after: str, reason: str) -> None:
    create_mock_app(MockDb(run_id=run_id, status=RunStatus.running, next_seq=4))
    messages, closed = receive_until_closed(f"/runs/{run_id}/stream?after={after}")
    assert messages == []
    assert (closed.code, closed.reason) == (4422, reason)


def test_a_finished_run_the_client_already_has_closes_with_1000_at_once(run_id: UUID) -> None:
    create_mock_app(MockDb(run_id=run_id, status=RunStatus.completed, next_seq=6))
    messages, closed = receive_until_closed(f"/runs/{run_id}/stream?after=5")
    assert messages == []  # nothing to stream, so no "ready" either
    assert (closed.code, closed.reason) == (1000, "Run finished")


def test_a_finished_run_replays_the_events_after_the_cursor_then_closes_with_1000(run_id: UUID) -> None:
    events = [
        queued_event(run_id),
        RunEvent(run_id=run_id, sequence=2, type=EventType.run_started, occurred_at=NOW),
        RunEvent(run_id=run_id, sequence=3, type=EventType.run_completed, occurred_at=NOW, payload={"ok": True}),
    ]
    create_mock_app(MockDb(run_id=run_id, status=RunStatus.completed, next_seq=4, events=events))

    messages, closed = receive_until_closed(f"/runs/{run_id}/stream?after=1")

    assert messages[0] == READY
    replayed = [RunEvent.model_validate(message) for message in messages[1:]]
    assert replayed == events[1:]  # one JSON text frame per event, in sequence order
    assert (closed.code, closed.reason) == (1000, "Run finished")


def test_the_stream_closes_with_1008_when_the_client_sends_a_message(run_id: UUID) -> None:
    create_mock_app(MockDb(run_id=run_id, status=RunStatus.running, next_seq=2, events=[queued_event(run_id)]))
    with TestClient(app).websocket_connect(f"/runs/{run_id}/stream") as websocket:
        assert websocket.receive_json() == READY
        assert websocket.receive_json()["sequence"] == 1
        websocket.send_text("approve, please")  # commands are HTTP POSTs; this socket only sends
        with pytest.raises(WebSocketDisconnect) as closed:
            websocket.receive_json()
    assert (closed.value.code, closed.value.reason) == (1008, "This stream does not accept messages")


def test_leaving_the_stream_releases_its_subscription(run_id: UUID) -> None:
    create_mock_app(MockDb(run_id=run_id, status=RunStatus.running, next_seq=2, events=[queued_event(run_id)]))
    with TestClient(app).websocket_connect(f"/runs/{run_id}/stream") as websocket:
        assert websocket.receive_json() == READY
        assert websocket.receive_json()["sequence"] == 1
        assert run_id in get_broker()._subscribers  # waiting for the run's next commit
    assert run_id not in get_broker()._subscribers


def test_an_unexpected_error_closes_with_1011_and_is_logged(run_id: UUID, caplog: pytest.LogCaptureFixture) -> None:
    @asynccontextmanager
    async def unavailable_database() -> AsyncIterator[AsyncSession]:
        sess = AsyncMock(spec=AsyncSession)
        sess.scalar.side_effect = OSError("connection refused")
        yield sess

    app.dependency_overrides[get_session] = unavailable_database

    messages, closed = receive_until_closed(f"/runs/{run_id}/stream")

    assert messages == []
    assert (closed.code, closed.reason) == (1011, "Internal error")  # the details stay in the server log
    assert f"The event stream of run {run_id} failed" in caplog.text


async def test_live_streaming_receives_event_and_keepalive(run_id: uuid4) -> None:
    broker = get_broker()
    events = [
        RunEvent(run_id=run_id, sequence=1, type=EventType.run_queued, occurred_at=NOW),
    ]
    mock_db = MockDb(run_id=run_id, status=RunStatus.running, next_seq=2, events=events)
    mock_opener = create_mock_app(mock_db)

    # The run finishing ends the stream by itself, so collecting it ends too.
    task = asyncio.create_task(_collect(stream_events(mock_opener, run_id, cursor=0, keepalive_timeout=0.05)))

    # Wait for first event (run.queued) and keepalive
    await asyncio.sleep(0.12)

    # Now add event 2 and complete run
    mock_db.events.append(RunEvent(run_id=run_id, sequence=2, type=EventType.run_completed, occurred_at=NOW))
    mock_db.next_seq = 3
    mock_db.status = RunStatus.completed
    broker.notify(run_id)

    received = await asyncio.wait_for(task, timeout=1.0)

    # The first item is event 1, at least one keepalive followed while the run was quiet, and event 2 came last.
    assert isinstance(received[0], RunEvent) and received[0].type == EventType.run_queued
    assert any(isinstance(item, StreamKeepalive) for item in received)
    assert _sequences(received) == [1, 2]
    assert isinstance(received[-1], RunEvent) and received[-1].type == EventType.run_completed


async def test_two_subscribers_and_disconnect_cleanup(run_id: uuid4) -> None:
    broker = get_broker()
    events = [
        RunEvent(run_id=run_id, sequence=1, type=EventType.run_queued, occurred_at=NOW),
    ]
    mock_db = MockDb(run_id=run_id, status=RunStatus.running, next_seq=2, events=events)
    mock_opener = create_mock_app(mock_db)

    from contextlib import aclosing

    # Start two independent subscribers
    sub1_items: list[StreamItem] = []
    sub2_items: list[StreamItem] = []

    async def subscribe(received: list[StreamItem]) -> None:
        async with aclosing(stream_events(mock_opener, run_id, cursor=0, keepalive_timeout=0.5)) as gen:
            async for item in gen:
                received.append(item)

    task1 = asyncio.create_task(subscribe(sub1_items))
    task2 = asyncio.create_task(subscribe(sub2_items))

    await asyncio.sleep(0.05)
    assert len(broker._subscribers[run_id]) == 2

    # Disconnect sub1 by cancelling its task
    task1.cancel()
    await asyncio.gather(task1, return_exceptions=True)

    # Verify sub1 unsubscribed from broker
    assert len(broker._subscribers[run_id]) == 1

    # Now emit event 2 and complete run
    mock_db.events.append(RunEvent(run_id=run_id, sequence=2, type=EventType.run_completed, occurred_at=NOW))
    mock_db.next_seq = 3
    mock_db.status = RunStatus.completed
    broker.notify(run_id)

    # Sub2 completes normally
    await asyncio.wait_for(task2, timeout=1.0)
    assert _sequences(sub2_items) == [1, 2]
    assert _sequences(sub1_items) == [1]  # cancelled before event 2 existed

    # Verify all subscribers cleaned up
    assert run_id not in broker._subscribers


async def test_stream_ends_at_the_next_keepalive_once_the_sign_in_is_invalid(run_id: uuid4) -> None:
    events = [RunEvent(run_id=run_id, sequence=1, type=EventType.run_queued, occurred_at=NOW)]
    mock_db = MockDb(run_id=run_id, status=RunStatus.running, next_seq=2, events=events)
    mock_opener = create_mock_app(mock_db)
    checked: list[AsyncSession] = []

    async def valid_until_checked_twice(session: AsyncSession) -> bool:
        checked.append(session)
        return len(checked) < 2  # signed in for the first read, revoked by the next wake-up

    stream = stream_events(mock_opener, run_id, 0, keepalive_timeout=0.05, is_authorized=valid_until_checked_twice)
    received: list[StreamItem] = []
    with pytest.raises(SignedOut):
        await asyncio.wait_for(_collect(stream, into=received), timeout=1.0)

    # No new events and no notify: the keepalive wake-up alone re-checked the sign-in and ended the stream.
    assert len(received) == 2
    assert isinstance(received[0], RunEvent) and received[0].sequence == 1
    assert isinstance(received[1], StreamKeepalive)
    assert len(checked) == 2 and all(session is not None for session in checked)
    assert run_id not in get_broker()._subscribers


async def test_stream_sends_nothing_when_the_sign_in_is_already_invalid(run_id: uuid4) -> None:
    events = [RunEvent(run_id=run_id, sequence=1, type=EventType.run_queued, occurred_at=NOW)]
    mock_opener = create_mock_app(MockDb(run_id=run_id, status=RunStatus.running, next_seq=2, events=events))

    async def signed_out(session: AsyncSession) -> bool:
        return False

    stream = stream_events(mock_opener, run_id, 0, keepalive_timeout=0.05, is_authorized=signed_out)
    received: list[StreamItem] = []
    with pytest.raises(SignedOut):
        await asyncio.wait_for(_collect(stream, into=received), timeout=1.0)
    assert received == []
    assert run_id not in get_broker()._subscribers


async def _collect(stream: AsyncIterator[StreamItem], into: list[StreamItem] | None = None) -> list[StreamItem]:
    """Every item until the stream ends; `into` keeps what arrived when it ends with an exception."""
    received = [] if into is None else into
    async for item in stream:
        received.append(item)
    return received


def _sequences(items: list[StreamItem]) -> list[int]:
    return [item.sequence for item in items if isinstance(item, RunEvent)]
