"""Give each integration test a freshly migrated, disposable PostgreSQL database with the policy index built."""

import asyncio
import os
import socket
import sys
from asyncio import create_subprocess_exec
from collections.abc import AsyncIterator, Awaitable, Callable
from functools import partial
from pathlib import Path
from uuid import uuid4

import pytest
import uvicorn
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db import get_session, get_session_factory
from app.main import app
from app.models import User
from app.search.embeddings import HashingEmbedder
from app.search.indexer import index_policies
from tests.integration.accounts import bearer_headers, create_user

BACKEND_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
async def sessions() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    admin_url = os.environ.get("TEST_DATABASE_URL")
    if not admin_url:
        pytest.skip("Set TEST_DATABASE_URL to a PostgreSQL server with CREATEDB permission")
    name = f"opspilot_test_{uuid4().hex}"
    admin = create_async_engine(admin_url, isolation_level="AUTOCOMMIT")
    target = make_url(admin_url).set(database=name)
    engine = create_async_engine(target)
    try:
        async with admin.connect() as conn:
            await conn.execute(text(f'CREATE DATABASE "{name}"'))
        try:
            env = {**os.environ, "DATABASE_URL": target.render_as_string(hide_password=False)}
            proc = await create_subprocess_exec(
                sys.executable, "-m", "alembic", "upgrade", "head", cwd=BACKEND_ROOT, env=env
            )
            assert await proc.wait() == 0, "Alembic failed on a fresh database"
            factory = async_sessionmaker(engine, expire_on_commit=False)
            # Like a seeded deployment, every test database can answer search_policies (agent-loop tests included).
            async with factory.begin() as session:
                await index_policies(session, HashingEmbedder())
            yield factory
        finally:
            await engine.dispose()
            async with admin.connect() as conn:
                await conn.execute(text(f'DROP DATABASE "{name}" WITH (FORCE)'))
    finally:
        await admin.dispose()


@pytest.fixture
async def db_session(sessions: async_sessionmaker[AsyncSession]) -> AsyncIterator[AsyncSession]:
    async with sessions() as session:
        yield session


@pytest.fixture
def make_user(sessions: async_sessionmaker[AsyncSession]) -> Callable[..., Awaitable[User]]:
    """Create an account in this test's database: `await make_user(email=..., display_name=...)`."""
    return partial(create_user, sessions)


@pytest.fixture
def auth_headers(sessions: async_sessionmaker[AsyncSession]) -> Callable[[User], Awaitable[dict[str, str]]]:
    """Sign a user in without the login endpoint: `await auth_headers(user)` gives the Authorization header."""
    return partial(bearer_headers, sessions)


@pytest.fixture
async def user(make_user: Callable[..., Awaitable[User]]) -> User:
    """One account, for tests that need a run owner."""
    return await make_user()


@pytest.fixture
async def user_headers(user: User, auth_headers: Callable[[User], Awaitable[dict[str, str]]]) -> dict[str, str]:
    """The Authorization header of `user`."""
    return await auth_headers(user)


@pytest.fixture
async def api_client(sessions: async_sessionmaker[AsyncSession]) -> AsyncIterator[AsyncClient]:
    """The FastAPI app over ASGI, using this test's database. The worker does not start, so runs stay queued."""

    async def isolated_session() -> AsyncIterator[AsyncSession]:
        async with sessions() as session:
            yield session

    app.dependency_overrides[get_session] = isolated_session
    app.dependency_overrides[get_session_factory] = lambda: sessions
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            yield client
    finally:
        app.dependency_overrides.pop(get_session, None)
        app.dependency_overrides.pop(get_session_factory, None)


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
async def server(sessions: async_sessionmaker[AsyncSession]) -> AsyncIterator[str]:
    """Run the app on a real Uvicorn server on a loopback port, using this test's database. Yields its base URL.

    The ASGI test client cannot open WebSockets, so the run stream is tested here. lifespan="off": the tests drive
    the agent themselves, so the app's worker does not start.
    """
    port = get_ephemeral_port()

    app.dependency_overrides[get_session_factory] = lambda: sessions

    async def isolated_session() -> AsyncIterator[AsyncSession]:
        async with sessions() as session:
            yield session

    app.dependency_overrides[get_session] = isolated_session

    config = uvicorn.Config(app=app, host="127.0.0.1", port=port, log_level="warning", lifespan="off")
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
