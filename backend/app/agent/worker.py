"""Lifespan worker for PostgreSQL-backed, serial run execution."""

import asyncio
import logging
from collections.abc import Callable
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.agent.contracts import LLMProvider
from app.agent.loop import execute_run, save_tool_result
from app.agent.runtime import resolve_run_provider
from app.agent.usage import Pricing, record_usage
from app.models import Message, ModelCall, Run, ToolCall
from app.runs.schemas import EventType, RunStatus, ToolError, ToolFailure
from app.runs.service import append_event

type Sessions = async_sessionmaker[AsyncSession]
type Resolver = Callable[[str, str], tuple[LLMProvider, Pricing | None]]
logger = logging.getLogger(__name__)
# Stable PostgreSQL advisory-lock namespace shared by API processes in this database.
WORKER_LOCK = 0x4F505350494C4F54


async def finish_interrupted(session: AsyncSession, run: Run, code: str, detail: str) -> None:
    """Close unfinished trace entries and publish the terminal event in the same transaction."""
    now = datetime.now(UTC)
    attempts = await session.scalars(select(ModelCall).where(ModelCall.run_id == run.id, ModelCall.status == "running"))
    for attempt in attempts:
        attempt.status = "failed"
        attempt.completed_at = now
        record_usage(run, attempt, None, None)
        await append_event(
            session,
            run.id,
            EventType.usage_updated,
            {
                "model_call_id": str(attempt.id),
                "usage_complete": False,
                "token_usage_complete": run.token_usage_complete,
                "cost_is_upper_bound": run.cost_is_upper_bound,
                "total_tokens": run.total_tokens,
                "estimated_cost_usd": None,
            },
        )
    messages = await session.scalars(select(Message).where(Message.run_id == run.id, Message.status == "running"))
    for message in messages:
        message.status = "failed"
        await append_event(
            session,
            run.id,
            EventType.message_completed,
            {"message_id": str(message.id), "status": message.status, "text": message.text},
        )
    index = await session.scalar(select(func.max(Message.index)).where(Message.run_id == run.id))
    calls = await session.scalars(
        select(ToolCall).where(ToolCall.run_id == run.id, ToolCall.result.is_(None)).order_by(ToolCall.position)
    )
    for next_index, call in enumerate(calls, start=0 if index is None else index + 1):
        await save_tool_result(session, call, ToolFailure(error=ToolError(code=code, message=detail)), next_index)

    cancelled = run.status == RunStatus.cancelling
    run.status = RunStatus.cancelled if cancelled else RunStatus.failed
    run.duration_ms = max(0, int((now - run.created_at).total_seconds() * 1000))
    await append_event(
        session,
        run.id,
        EventType.run_cancelled if cancelled else EventType.run_failed,
        {"status": run.status, "code": code, "message": detail},
    )


async def recover(sessions: Sessions) -> None:
    async with sessions.begin() as session:
        abandoned = await session.scalars(
            select(Run)
            .where(Run.status.in_([RunStatus.running, RunStatus.cancelling]))
            .order_by(Run.id)
            .with_for_update()
        )
        for run in abandoned:
            await finish_interrupted(session, run, "PROCESS_RESTARTED", "Run execution was interrupted by a restart.")


async def claim(sessions: Sessions) -> tuple[UUID, str, str] | None:
    async with sessions.begin() as session:
        run = await session.scalar(
            select(Run)
            .where(Run.status == RunStatus.queued)
            .order_by(Run.created_at, Run.id)
            .limit(1)
            .with_for_update()
        )
        if run is None:
            return None
        run.status = RunStatus.running
        await append_event(session, run.id, EventType.run_started, {"status": run.status})
        return run.id, run.provider, run.model


async def consume(sessions: Sessions, resolve: Resolver, poll_interval: float) -> None:
    await recover(sessions)
    while True:
        claimed = await claim(sessions)
        if claimed is None:
            await asyncio.sleep(poll_interval)
            continue
        run_id, name, model = claimed
        try:
            provider, pricing = resolve(name, model)
        except Exception:
            logger.warning("Provider configuration unavailable", extra={"run_id": str(run_id)})
            async with sessions.begin() as session:
                run = await session.get_one(Run, run_id, with_for_update=True)
                await finish_interrupted(
                    session, run, "PROVIDER_CONFIGURATION_ERROR", "The configured model is unavailable."
                )
            continue
        await execute_run(sessions, run_id, provider, pricing)


async def try_lead(engine: AsyncEngine, sessions: Sessions, resolve: Resolver, poll_interval: float) -> None:
    async with engine.connect() as connection:
        try:
            acquired = await connection.scalar(text("SELECT pg_try_advisory_lock(:key)"), {"key": WORKER_LOCK})
            await connection.commit()
        except BaseException:
            # Cancellation can race delivery of the successful lock response.
            await connection.invalidate()
            raise
        if not acquired:
            return
        try:
            raw = (await connection.get_raw_connection()).driver_connection
            if raw is None:
                raise ConnectionError("PostgreSQL ownership connection is closed.")
            async with asyncio.TaskGroup() as tasks:
                consumer = tasks.create_task(consume(sessions, resolve, poll_interval))

                def lost_connection(_: object) -> None:
                    consumer.cancel()

                raw.add_termination_listener(lost_connection)
                if raw.is_closed():
                    consumer.cancel()
        finally:
            # Physically close the PostgreSQL session before returning its pool slot.
            await connection.invalidate()


async def run_worker(
    engine: AsyncEngine, sessions: Sessions, resolve: Resolver = resolve_run_provider, *, poll_interval: float = 0.5
) -> None:
    while True:
        try:
            await try_lead(engine, sessions, resolve, poll_interval)
        except Exception:
            logger.warning("Queue worker lost database access or could not process a run. Retrying.")
        await asyncio.sleep(poll_interval)
