"""Give each integration test a freshly migrated, disposable PostgreSQL database with the policy index built."""

import os
import sys
from asyncio import create_subprocess_exec
from collections.abc import AsyncIterator
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.search.embeddings import HashingEmbedder
from app.search.indexer import index_policies

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

