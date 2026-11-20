"""Run versioned migrations with the application's async database configuration."""

import asyncio

from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import create_async_engine

from alembic import context
from app.config import settings
from app.models import Base


def migrate(connection: Connection) -> None:
    context.configure(connection=connection, target_metadata=Base.metadata, compare_server_default=True)
    with context.begin_transaction():
        context.run_migrations()


async def migrate_online() -> None:
    engine = create_async_engine(str(settings.database_url), poolclass=pool.NullPool)
    try:
        async with engine.connect() as connection:
            await connection.run_sync(migrate)
    finally:
        await engine.dispose()


if context.is_offline_mode():
    context.configure(url=str(settings.database_url), target_metadata=Base.metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
elif connection := context.config.attributes.get("connection"):
    migrate(connection)
else:
    asyncio.run(migrate_online())
