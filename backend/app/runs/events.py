"""Persist ordered run events and manage lightweight subscription notifications."""

import asyncio
from collections import defaultdict
from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from uuid import UUID

from pydantic import JsonValue
from sqlalchemy import event as sa_event
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Run, RunEventRecord
from app.runs.schemas import EventType, RunEvent, RunStatus, StreamKeepalive

KEEPALIVE_SECONDS = 15.0
TERMINAL_STATUSES = {RunStatus.completed, RunStatus.failed, RunStatus.cancelled}


class SignedOut(Exception):
    """The sign-in behind a stream was revoked or has expired: the stream stops, and the client must sign in again."""


class EventBroker:
    """In-memory pub-sub wake-up hint for active stream subscribers."""

    def __init__(self) -> None:
        self._subscribers: dict[UUID, set[asyncio.Event]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def subscribe(self, run_id: UUID) -> asyncio.Event:
        ev = asyncio.Event()
        async with self._lock:
            self._subscribers[run_id].add(ev)
        return ev

    async def unsubscribe(self, run_id: UUID, ev: asyncio.Event) -> None:
        async with self._lock:
            subs = self._subscribers.get(run_id)
            if subs:
                subs.discard(ev)
                if not subs:
                    self._subscribers.pop(run_id, None)

    def notify(self, run_id: UUID) -> None:
        """Wake all active subscribers for run_id."""
        subs = self._subscribers.get(run_id)
        if subs:
            for ev in list(subs):
                ev.set()


_BROKER = EventBroker()


def get_broker() -> EventBroker:
    return _BROKER


def _register_post_commit_notification(session: AsyncSession, run_id: UUID) -> None:
    """Schedule broker notification after the database transaction commits."""
    if "runs_to_notify" not in session.info:
        session.info["runs_to_notify"] = set()

        @sa_event.listens_for(session.sync_session, "after_commit", once=True)
        def _on_commit(*_args: object) -> None:
            runs = session.info.pop("runs_to_notify", set())
            for rid in runs:
                get_broker().notify(rid)

        @sa_event.listens_for(session.sync_session, "after_rollback", once=True)
        def _on_rollback(*_args: object) -> None:
            session.info.pop("runs_to_notify", None)

    session.info["runs_to_notify"].add(run_id)


async def append_event(
    session: AsyncSession, run_id: UUID, kind: EventType, payload: dict[str, JsonValue]
) -> RunEventRecord:
    """Allocate the sequence on the run row and persist the event.

    The sequence is allocated atomically on the run row using an atomic update.
    Subscribers are notified only after the transaction is successfully committed.
    """
    next_sequence = (
        await session.execute(
            update(Run)
            .where(Run.id == run_id)
            .values(next_event_sequence=Run.next_event_sequence + 1)
            .returning(Run.next_event_sequence)
        )
    ).scalar_one()
    record = RunEventRecord(run_id=run_id, sequence=next_sequence - 1, type=kind.value, payload=payload)
    session.add(record)
    await session.flush()
    _register_post_commit_notification(session, run_id)
    return record


async def read_events(session: AsyncSession, run_id: UUID, after: int = 0, limit: int = 100) -> list[RunEvent]:
    """Read a bounded batch of committed events for run_id strictly after the given sequence."""
    records = await session.scalars(
        select(RunEventRecord)
        .where(RunEventRecord.run_id == run_id, RunEventRecord.sequence > after)
        .order_by(RunEventRecord.sequence.asc())
        .limit(limit)
    )
    return [RunEvent.model_validate(r, from_attributes=True) for r in records]


async def get_run_stream_info(session: AsyncSession, run_id: UUID) -> tuple[RunStatus, int] | None:
    """Read run status and latest event sequence."""
    run = await session.scalar(select(Run).where(Run.id == run_id))
    if run is None:
        return None
    latest_sequence = run.next_event_sequence - 1
    return RunStatus(run.status), latest_sequence


async def stream_events(
    session_opener: Callable[[], AbstractAsyncContextManager[AsyncSession]],
    run_id: UUID,
    cursor: int,
    *,
    keepalive_timeout: float = KEEPALIVE_SECONDS,
    is_authorized: Callable[[AsyncSession], Awaitable[bool]] | None = None,
) -> AsyncGenerator[RunEvent | StreamKeepalive, None]:
    """Yield run_id's committed events after cursor in sequence order, then follow the run live.

    The caller decides how each item goes over the wire, so this works for any transport. It reads bounded
    batches from PostgreSQL and never executes or resumes the agent. After keepalive_timeout seconds without
    a new event it yields a StreamKeepalive. It returns once the run has finished and its last event was yielded.

    is_authorized is awaited with each fresh database session, i.e. before every batch and after every
    keepalive wait. When it answers False this raises SignedOut, so a stream ends within one keepalive
    interval once its sign-in is revoked or expires.
    """
    broker = get_broker()
    sub_event = await broker.subscribe(run_id)
    current_cursor = cursor
    try:
        while True:
            async with session_opener() as session:
                if is_authorized is not None and not await is_authorized(session):
                    raise SignedOut
                events = await read_events(session, run_id, after=current_cursor, limit=100)
                stream_info = await get_run_stream_info(session, run_id)

            if stream_info is None:
                break
            status, latest_seq = stream_info

            if events:
                for event in events:
                    yield event
                    current_cursor = event.sequence
                if len(events) >= 100:
                    continue

            if status in TERMINAL_STATUSES:
                if current_cursor >= latest_seq:
                    break
                continue

            try:
                await asyncio.wait_for(sub_event.wait(), timeout=keepalive_timeout)
                sub_event.clear()
            except TimeoutError:
                yield StreamKeepalive()
    finally:
        await broker.unsubscribe(run_id, sub_event)
