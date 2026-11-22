"""Unit tests for the SSE streaming endpoint contracts, cursor validation, and framing."""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.main import app
from app.runs.events import get_broker
from app.runs.schemas import EventType, RunEvent, RunStatus

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


@pytest.fixture(autouse=True)
def cleanup_overrides():
    yield
    app.dependency_overrides.pop(get_session, None)


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

    from app.runs.events import stream_events

    received: list[str] = []

    async def run_stream():
        async for chunk in stream_events(mock_opener, run_id, cursor=0, keepalive_timeout=0.05):
            received.append(chunk)
            if "run.completed" in chunk:
                break

    task = asyncio.create_task(run_stream())

    # Wait for first event (run.queued) and keepalive
    await asyncio.sleep(0.12)

    # Now add event 2 and complete run
    mock_db.events.append(RunEvent(run_id=run_id, sequence=2, type=EventType.run_completed, occurred_at=NOW))
    mock_db.next_seq = 3
    mock_db.status = RunStatus.completed
    broker.notify(run_id)

    await asyncio.wait_for(task, timeout=1.0)

    # First chunk is event 1
    assert "id: 1\nevent: run.queued" in received[0]
    # At least one keepalive comment was received
    assert any(chunk == ": keepalive\n\n" for chunk in received)
    # Event 2 was received
    assert any("id: 2\nevent: run.completed" in chunk for chunk in received)


async def test_two_subscribers_and_disconnect_cleanup(run_id: uuid4) -> None:
    broker = get_broker()
    events = [
        RunEvent(run_id=run_id, sequence=1, type=EventType.run_queued, occurred_at=NOW),
    ]
    mock_db = MockDb(run_id=run_id, status=RunStatus.running, next_seq=2, events=events)
    mock_opener = create_mock_app(mock_db)

    from contextlib import aclosing

    from app.runs.events import stream_events

    # Start two independent subscribers
    sub1_chunks: list[str] = []
    sub2_chunks: list[str] = []

    async def sub1():
        async with aclosing(stream_events(mock_opener, run_id, cursor=0, keepalive_timeout=0.5)) as gen:
            async for chunk in gen:
                sub1_chunks.append(chunk)
                if "run.completed" in chunk:
                    break

    async def sub2():
        async with aclosing(stream_events(mock_opener, run_id, cursor=0, keepalive_timeout=0.5)) as gen:
            async for chunk in gen:
                sub2_chunks.append(chunk)
                if "run.completed" in chunk:
                    break

    task1 = asyncio.create_task(sub1())
    task2 = asyncio.create_task(sub2())

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
    assert any("id: 2\nevent: run.completed" in chunk for chunk in sub2_chunks)

    # Verify all subscribers cleaned up
    assert run_id not in broker._subscribers



