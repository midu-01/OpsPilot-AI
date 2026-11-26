"""Unit tests for the SSE streaming endpoint contracts, cursor validation, and framing."""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user, get_sign_in_check
from app.db import get_session
from app.main import app
from app.models import User
from app.runs.events import SignedOut, get_broker, stream_events
from app.runs.routes import require_run_owner
from app.runs.schemas import EventType, RunEvent, RunStatus, StreamKeepalive

type StreamItem = RunEvent | StreamKeepalive

NOW = datetime.now(UTC)


class MockDb:
    def __init__(self, run_id: uuid4, status: RunStatus, next_seq: int, events: list[RunEvent] | None = None) -> None:
        self.run_id = run_id
        self.status = status
        self.next_seq = next_seq
        self.events = events or []


@pytest.fixture
def run_id() -> uuid4:
    return uuid4()


def create_mock_app(mock_db: MockDb):
    @asynccontextmanager
    async def mock_session() -> AsyncIterator[AsyncSession]:
        from unittest.mock import AsyncMock

        sess = AsyncMock(spec=AsyncSession)

        async def mock_scalar(query, *args, **kwargs):
            query_str = str(query)
            if "FROM runs" in query_str:
                from app.models import Run

                return Run(
                    id=mock_db.run_id,
                    status=mock_db.status.value,
                    next_event_sequence=mock_db.next_seq,
                )
            return None

        async def mock_scalars(query, *args, **kwargs):
            from app.models import RunEventRecord

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
                for e in mock_db.events
                if e.sequence > after_seq
            ]

        sess.scalar = mock_scalar
        sess.scalars = mock_scalars
        yield sess

    app.dependency_overrides[get_session] = mock_session
    return mock_session


async def always_signed_in(session: AsyncSession) -> bool:
    return True


@pytest.fixture(autouse=True)
def cleanup_overrides():
    """These tests mock the database, so stand in for sign-in and ownership (both covered by integration tests)."""
    signed_in = User(id=uuid4(), email="alex@opspilot.test", display_name="Alex Rivera", password_hash="unused")
    app.dependency_overrides[get_current_user] = lambda: signed_in
    app.dependency_overrides[require_run_owner] = lambda: None
    app.dependency_overrides[get_sign_in_check] = lambda: always_signed_in
    yield
    for dependency in (get_session, get_current_user, require_run_owner, get_sign_in_check):
        app.dependency_overrides.pop(dependency, None)


async def test_stream_unknown_run_returns_404() -> None:
    @asynccontextmanager
    async def mock_session() -> AsyncIterator[AsyncSession]:
        from unittest.mock import AsyncMock

        sess = AsyncMock(spec=AsyncSession)
        sess.scalar.return_value = None
        yield sess

    app.dependency_overrides[get_session] = mock_session
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.get(f"/runs/{uuid4()}/stream")
        assert res.status_code == 404
        assert res.json()["detail"] == "Run not found"


@pytest.mark.parametrize(
    ("params", "headers", "error_msg"),
    [
        ({"after": "invalid"}, {}, "Invalid event cursor"),
        ({"after": "-1"}, {}, "Cursor must be non-negative"),
        ({"after": "1.5"}, {}, "Invalid event cursor"),
        ({}, {"Last-Event-ID": "invalid"}, "Invalid event cursor"),
        ({}, {"Last-Event-ID": "-5"}, "Cursor must be non-negative"),
    ],
)
async def test_stream_malformed_cursor_returns_422(params: dict, headers: dict, error_msg: str) -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.get(f"/runs/{uuid4()}/stream", params=params, headers=headers)
        assert res.status_code == 422
        assert error_msg in res.json()["detail"]


async def test_stream_future_cursor_returns_422(run_id: uuid4) -> None:
    # Run has latest sequence 3 (next_event_sequence=4)
    mock_db = MockDb(run_id=run_id, status=RunStatus.running, next_seq=4)
    create_mock_app(mock_db)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.get(f"/runs/{run_id}/stream?after=5")
        assert res.status_code == 422
        assert "Cursor is ahead of the run's latest sequence" in res.json()["detail"]


async def test_terminal_run_already_consumed_returns_204(run_id: uuid4) -> None:
    # Terminal run with latest sequence 5, client connects with after=5
    mock_db = MockDb(run_id=run_id, status=RunStatus.completed, next_seq=6)
    create_mock_app(mock_db)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.get(f"/runs/{run_id}/stream?after=5")
        assert res.status_code == 204


async def test_terminal_run_with_unconsumed_events_drains_and_closes(run_id: uuid4) -> None:
    events = [
        RunEvent(run_id=run_id, sequence=1, type=EventType.run_queued, occurred_at=NOW),
        RunEvent(run_id=run_id, sequence=2, type=EventType.run_started, occurred_at=NOW),
        RunEvent(run_id=run_id, sequence=3, type=EventType.run_completed, occurred_at=NOW),
    ]
    mock_db = MockDb(run_id=run_id, status=RunStatus.completed, next_seq=4, events=events)
    create_mock_app(mock_db)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.get(f"/runs/{run_id}/stream?after=0")
        assert res.status_code == 200
        assert "text/event-stream" in res.headers["content-type"]
        assert res.headers["cache-control"] == "no-cache, no-transform"
        assert res.headers["x-accel-buffering"] == "no"

        body = res.text
        assert "id: 1\nevent: run.queued" in body
        assert "id: 2\nevent: run.started" in body
        assert "id: 3\nevent: run.completed" in body


async def test_last_event_id_takes_precedence_over_after(run_id: uuid4) -> None:
    events = [
        RunEvent(run_id=run_id, sequence=1, type=EventType.run_queued, occurred_at=NOW),
        RunEvent(run_id=run_id, sequence=2, type=EventType.run_started, occurred_at=NOW),
    ]
    # latest sequence is 2. If after=0 but Last-Event-ID=2, then client already has event 2.
    # Terminal run: should return 204!
    mock_db = MockDb(run_id=run_id, status=RunStatus.completed, next_seq=3, events=events)
    create_mock_app(mock_db)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.get(
            f"/runs/{run_id}/stream?after=0",
            headers={"Last-Event-ID": "2"},
        )
        assert res.status_code == 204


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
