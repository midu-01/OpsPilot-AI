"""A real WebSocket client for the run stream, for tests that run the app on a live Uvicorn server."""

import asyncio
import json
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed

from app.runs.schemas import RunEvent

READY = {"type": "stream.ready"}
CONTROL_MESSAGES = [READY, {"type": "stream.keepalive"}]
# Shorter than the stream's 15 s keepalive, so a test that waits for a close fails instead of passing late.
READ_TIMEOUT_SECONDS = 10.0


def open_stream(server: str, run_id: UUID, headers: dict[str, str], after: int | None = None) -> connect:
    """Connect to a run's stream the way the console's proxy does: the bearer token travels in the handshake."""
    url = f"{server.replace('http://', 'ws://', 1)}/runs/{run_id}/stream"
    if after is not None:
        url = f"{url}?after={after}"
    return connect(url, additional_headers=headers, proxy=None, open_timeout=5)


@dataclass(frozen=True)
class Received:
    """Everything one connection delivered, and how the server closed it."""

    messages: list[dict[str, Any]]
    close_code: int | None
    close_reason: str | None

    @property
    def events(self) -> list[RunEvent]:
        return [RunEvent.model_validate(message) for message in self.messages if message not in CONTROL_MESSAGES]


async def read_until_closed(connection: ClientConnection) -> Received:
    """Read every message until the server closes the socket."""
    messages: list[dict[str, Any]] = []
    async with asyncio.timeout(READ_TIMEOUT_SECONDS):
        try:
            async for raw in connection:  # ends by itself on a normal close (1000)
                messages.append(json.loads(raw))
        except ConnectionClosed:
            pass  # any other close code: it is on the connection
    return Received(messages, connection.close_code, connection.close_reason)
