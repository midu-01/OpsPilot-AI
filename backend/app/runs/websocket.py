"""The live stream of a run's events: a WebSocket at /runs/{run_id}/stream.

A browser cannot read why a WebSocket handshake was refused (it only ever sees code 1006), so this route
accepts first, then makes the checks the HTTP run routes make, and ends with a close code the console acts on:

    1000  the run has finished and its last event was sent
    4401  no valid sign-in, or it ended while streaming: sign in again
    4404  a missing run, or another user's (a run ID reveals nothing)
    4422  the cursor is malformed or ahead of the run: reload the snapshot
    1008  the client sent a message: this stream only sends
    1011  an unexpected server error: reconnect

Each message is one JSON text frame, told apart by its "type":

    {"type": "stream.ready"}      the checks passed: the committed events after the cursor follow, then live ones
    a RunEvent                    one committed event, in sequence order ("type" is the event type)
    {"type": "stream.keepalive"}  15 s without events: the connection is alive and the sign-in was checked again

Commands (approve, reject, stop) stay HTTP POSTs: they need answers such as 409, and they go through the
console's same-origin proxy like every other write.
"""

import asyncio
import logging
from collections.abc import AsyncGenerator, AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, aclosing, asynccontextmanager, suppress
from dataclasses import dataclass
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import HTTPConnection

from app.auth.dependencies import CallerLookup, UserLookup
from app.db import get_session, get_session_factory
from app.models import Run
from app.runs import events
from app.runs.schemas import RunEvent, RunStatus, StreamKeepalive, StreamReady

logger = logging.getLogger("opspilot")

type SessionOpener = Callable[[], AbstractAsyncContextManager[AsyncSession]]
type StreamItems = AsyncGenerator[RunEvent | StreamKeepalive, None]


@dataclass(frozen=True)
class Close:
    """How the server ends a stream: a WebSocket close code and a short reason (at most 123 bytes)."""

    code: int
    reason: str


FINISHED = Close(status.WS_1000_NORMAL_CLOSURE, "Run finished")
UNEXPECTED_MESSAGE = Close(status.WS_1008_POLICY_VIOLATION, "This stream does not accept messages")
SERVER_ERROR = Close(status.WS_1011_INTERNAL_ERROR, "Internal error")
# Codes 4000-4999 belong to the application. These mirror the HTTP statuses of the other run routes.
NOT_AUTHENTICATED = Close(4401, "Not authenticated")
RUN_NOT_FOUND = Close(4404, "Run not found")
CURSOR_NOT_AN_INTEGER = Close(4422, "Invalid event cursor; expected an integer")
CURSOR_NEGATIVE = Close(4422, "Cursor must be non-negative")
CURSOR_AHEAD = Close(4422, "Cursor is ahead of the run's latest sequence")


class EndStream(Exception):
    """Stop streaming, and close the socket with `close`."""

    def __init__(self, close: Close) -> None:
        super().__init__(close.reason)
        self.close = close


# Not on the /runs router: its sign-in dependency answers 401 before the handshake completes.
router = APIRouter(prefix="/runs", tags=["runs"])


@router.websocket("/{run_id}/stream")
async def stream_run(
    websocket: WebSocket,
    run_id: UUID,
    find_caller: CallerLookup,
    after: Annotated[str | None, Query(description="The last event sequence the client already has")] = None,
) -> None:
    await websocket.accept()
    opener = make_session_opener(websocket)

    async def still_signed_in(session: AsyncSession) -> bool:
        return await find_caller(session) is not None

    try:
        cursor = await check_subscription(opener, run_id, find_caller, after)
        await websocket.send_text(StreamReady().model_dump_json())
        await relay(websocket, events.stream_events(opener, run_id, cursor, is_authorized=still_signed_in))
        close = FINISHED
    except EndStream as end:
        close = end.close
    except WebSocketDisconnect:
        return  # the client left: there is nobody to tell
    except Exception:
        logger.exception("The event stream of run %s failed", run_id)
        close = SERVER_ERROR
    with suppress(WebSocketDisconnect):  # the client may leave while we close
        await websocket.close(close.code, close.reason)


async def check_subscription(opener: SessionOpener, run_id: UUID, find_caller: UserLookup, after: str | None) -> int:
    """Return the cursor to stream from, or raise EndStream when there is nothing to stream.

    The same checks as the HTTP run routes, in the same order: the sign-in, the owner, then the cursor. A finished
    run whose last event the client already has ends at once with 1000.
    """
    async with opener() as session:
        user = await find_caller(session)
        if user is None:
            raise EndStream(NOT_AUTHENTICATED)
        run = await session.scalar(select(Run).where(Run.id == run_id))
    if run is None or run.user_id != user.id:  # also true for a run without an owner
        raise EndStream(RUN_NOT_FOUND)

    cursor = parse_cursor(after)
    latest_sequence = run.next_event_sequence - 1
    if cursor > latest_sequence:
        raise EndStream(CURSOR_AHEAD)
    if RunStatus(run.status) in events.TERMINAL_STATUSES and cursor >= latest_sequence:
        raise EndStream(FINISHED)
    return cursor


def parse_cursor(after: str | None) -> int:
    """The last sequence the client already has; none (0) when absent."""
    if after is None:
        return 0
    try:
        cursor = int(after)
    except ValueError:
        raise EndStream(CURSOR_NOT_AN_INTEGER) from None
    if cursor < 0:
        raise EndStream(CURSOR_NEGATIVE)
    return cursor


async def relay(websocket: WebSocket, items: StreamItems) -> None:
    """Send every item until the stream ends, while listening for the client to leave.

    Sending alone would notice a closed socket only at its next send, up to a keepalive interval later. So a second
    task waits on receive(), and the first of the two to finish stops both. Returns when the run has finished;
    raises EndStream or WebSocketDisconnect otherwise.
    """
    sending = asyncio.create_task(send_items(websocket, items))
    listening = asyncio.create_task(listen_for_disconnect(websocket))
    try:
        done, _ = await asyncio.wait({sending, listening}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        sending.cancel()
        listening.cancel()
        # Let both finish (the subscription unsubscribes in a finally). Unlike gather, asyncio.wait re-raises this
        # task's own cancellation unchanged if it is cancelled meanwhile, e.g. when the server shuts down.
        await asyncio.wait({sending, listening})
    # When both finished at once, sending decides: it knows whether the run ended.
    first, other = (sending, listening) if sending in done else (listening, sending)
    if other in done:
        other.exception()  # retrieved, so asyncio does not log "Task exception was never retrieved"
    first.result()  # returns, or raises how the stream ended


async def send_items(websocket: WebSocket, items: StreamItems) -> None:
    async with aclosing(items) as stream:
        try:
            async for item in stream:
                await websocket.send_text(item.model_dump_json())
        except events.SignedOut:
            raise EndStream(NOT_AUTHENTICATED) from None


async def listen_for_disconnect(websocket: WebSocket) -> None:
    """The console never sends anything: wait until it leaves. A message from it breaks the protocol."""
    message = await websocket.receive()
    if message["type"] == "websocket.disconnect":
        raise WebSocketDisconnect(message.get("code", status.WS_1000_NORMAL_CLOSURE), message.get("reason"))
    raise EndStream(UNEXPECTED_MESSAGE)


def make_session_opener(connection: HTTPConnection) -> SessionOpener:
    """Open a short-lived session per database read, so an idle stream holds no pooled connection.

    It honours the tests' overrides of get_session and get_session_factory, like a dependency would.
    """

    @asynccontextmanager
    async def open_session() -> AsyncIterator[AsyncSession]:
        override_sess = connection.app.dependency_overrides.get(get_session)
        if override_sess:
            gen = override_sess()
            if hasattr(gen, "__aenter__"):
                async with gen as session:
                    yield session
            elif hasattr(gen, "__anext__"):
                session = await anext(gen)
                try:
                    yield session
                finally:
                    await gen.aclose()
            else:
                yield override_sess()
            return

        override_factory = connection.app.dependency_overrides.get(get_session_factory)
        factory = override_factory() if override_factory else get_session_factory()
        async with factory() as session:
            yield session

    return open_session
