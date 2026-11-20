import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from app import main


@pytest.fixture
async def client() -> AsyncIterator[AsyncClient]:
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        yield client


async def test_ready_queries_database_and_disposes_pool(client: AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    connection = AsyncMock()
    db = MagicMock()
    db.connect.return_value.__aenter__.return_value = connection
    db.dispose = AsyncMock()
    monkeypatch.setattr(main, "engine", db)
    async with main.lifespan(main.app):
        response = await client.get("/health/ready")
    assert response.status_code == 200
    assert response.json() == {"status": "ready", "details": {"database": "connected"}}
    assert str(connection.execute.await_args.args[0]) == "SELECT 1"
    db.dispose.assert_awaited_once()


async def test_database_failure_keeps_liveness_up_and_hides_details(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    db = MagicMock()
    db.connect.side_effect = ConnectionError("internal diagnostic")
    monkeypatch.setattr(main, "engine", db)
    response = await client.get("/health/live")
    assert response.status_code == 200
    db.connect.assert_not_called()
    response = await client.get("/health/ready")
    assert response.status_code == 503
    assert response.json() == {"status": "unavailable", "details": {"database": "unavailable"}}
    assert "internal diagnostic" not in caplog.text


async def test_readiness_times_out_while_acquiring_connection(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    @asynccontextmanager
    async def connect() -> AsyncIterator[AsyncMock]:
        await asyncio.sleep(60)
        yield AsyncMock()

    db = MagicMock()
    db.connect = connect
    monkeypatch.setattr(main, "engine", db)
    monkeypatch.setattr(main, "READINESS_TIMEOUT_SECONDS", 0.01)
    async with asyncio.timeout(1):
        response = await client.get("/health/ready")
    assert response.status_code == 503
