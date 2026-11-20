import asyncio
from collections.abc import AsyncIterator
from uuid import UUID, uuid4

from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db import get_session
from app.main import app
from app.runs.schemas import EventType
from app.runs.service import append_event, create_run, get_snapshot


async def test_run_survives_new_request_and_session(sessions: async_sessionmaker[AsyncSession]) -> None:
    async def isolated_session() -> AsyncIterator[AsyncSession]:
        async with sessions() as session:
            yield session

    app.dependency_overrides[get_session] = isolated_session
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            first = await client.post("/runs", json={"goal": "Find delayed shipments"})
            assert first.status_code == 202
            run_id = first.json()["id"]
            detail = (await client.get(f"/runs/{run_id}")).raise_for_status().json()
            assert detail["status"] == "queued"
            assert [(m["role"], m["text"]) for m in detail["messages"]] == [("user", "Find delayed shipments")]
            assert [(e["sequence"], e["type"]) for e in detail["events"]] == [(1, "run.queued")]
            assert detail["snapshot_cursor"] == 1
            assert (await client.post("/runs", json={"goal": "Second goal"})).status_code == 202
            listing = (await client.get("/runs?page=2&page_size=1")).raise_for_status().json()
            assert listing["total"] == 2 and listing["items"][0]["id"] == run_id
            assert (await client.get(f"/runs/{uuid4()}")).status_code == 404
    finally:
        del app.dependency_overrides[get_session]


async def test_event_counter_rollback_and_concurrent_writers(sessions: async_sessionmaker[AsyncSession]) -> None:
    async with sessions() as session:
        run = await create_run(session, "Check event ordering")
        await append_event(session, run.id, EventType.message_delta, {"text": "discarded"})
        await session.rollback()

    async def write(run_id: UUID, text: str) -> None:
        async with sessions.begin() as writer:
            await append_event(writer, run_id, EventType.message_delta, {"text": text})

    await asyncio.gather(write(run.id, "first writer"), write(run.id, "second writer"))
    async with sessions() as reader:
        snapshot = await get_snapshot(reader, run.id)
        assert snapshot is not None
        assert [e.sequence for e in snapshot.events] == [1, 2, 3]
        assert snapshot.snapshot_cursor == 3
        assert {e.payload["text"] for e in snapshot.events[1:]} == {"first writer", "second writer"}
