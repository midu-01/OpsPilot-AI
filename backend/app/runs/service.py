"""Transaction boundaries for queued runs and their public history."""

from collections import defaultdict
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import Approval, Message, ModelCall, Run, RunEventRecord, ToolCall
from app.runs.events import append_event as append_event
from app.runs.schemas import (
    ApprovalSnapshot,
    ApprovalStatus,
    EventType,
    MessageSnapshot,
    ModelAttemptSnapshot,
    PaginatedRuns,
    RunEvent,
    RunSnapshot,
    RunStatus,
    RunSummary,
    ToolCallSnapshot,
)


async def create_run(session: AsyncSession, goal: str) -> RunSummary:
    async with session.begin():
        run = Run(
            goal=goal,
            status=RunStatus.queued.value,
            provider=settings.llm_provider,
            model=settings.selected_model,
            reference_time=datetime.now(UTC),
            business_timezone=settings.business_timezone,
            max_agent_steps=settings.max_agent_steps,
            max_tool_calls=settings.max_tool_calls,
            model_timeout_seconds=settings.model_timeout_seconds,
            max_active_run_seconds=settings.max_active_run_seconds,
        )
        session.add(run)
        await session.flush()
        session.add(Message(run_id=run.id, index=0, role="user", text=goal))
        await append_event(session, run.id, EventType.run_queued, {"status": RunStatus.queued.value})
        await session.refresh(run)
        return RunSummary.model_validate(run, from_attributes=True)


async def list_runs(session: AsyncSession, page: int, page_size: int) -> PaginatedRuns:
    async with session.begin():
        await session.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"))
        total = await session.scalar(select(func.count()).select_from(Run))
        rows = await session.scalars(
            select(Run).order_by(Run.created_at.desc(), Run.id.desc()).offset((page - 1) * page_size).limit(page_size)
        )
        return PaginatedRuns(
            items=[RunSummary.model_validate(run, from_attributes=True) for run in rows],
            total=total or 0,
            page=page,
            page_size=page_size,
        )


async def get_snapshot(session: AsyncSession, run_id: UUID) -> RunSnapshot | None:
    """Return a consistent run snapshot, full persisted trace, pending approval, and snapshot_cursor.

    The snapshot returns all persisted events and messages under a shared read lock on the run row,
    ensuring snapshot_cursor equals the latest included event. Any events committed after this cursor
    will have sequence > snapshot_cursor and can be streamed without gaps or duplicates.
    """
    # Writers reserve the event sequence on this same row before committing.
    # Keep the shared lock while reading the public trace and its cursor.
    async with session.begin():
        run = await session.scalar(select(Run).where(Run.id == run_id).with_for_update(read=True))
        if run is None:
            return None
        calls = await session.scalars(select(ToolCall).where(ToolCall.run_id == run_id).order_by(ToolCall.position))
        grouped: dict[UUID, list[ToolCallSnapshot]] = defaultdict(list)
        for call in calls:
            grouped[call.message_id].append(ToolCallSnapshot.model_validate(call, from_attributes=True))
        messages = [
            MessageSnapshot.model_validate(row, from_attributes=True).model_copy(update={"tool_calls": grouped[row.id]})
            for row in await session.scalars(select(Message).where(Message.run_id == run_id).order_by(Message.index))
        ]
        decisions = await session.execute(
            select(Approval, ToolCall.name)
            .join(ToolCall, ToolCall.id == Approval.tool_call_id)
            .where(Approval.run_id == run_id)
            .order_by(Approval.created_at, Approval.id)
        )
        approvals = [
            ApprovalSnapshot(
                id=a.id,
                tool_call_id=a.tool_call_id,
                tool_name=name,
                proposed_arguments=a.proposed_arguments,
                status=ApprovalStatus(a.status),
                reason=a.reason,
                decided_at=a.decided_at,
            )
            for a, name in decisions
        ]
        events = [
            RunEvent.model_validate(row, from_attributes=True)
            for row in await session.scalars(
                select(RunEventRecord).where(RunEventRecord.run_id == run_id).order_by(RunEventRecord.sequence)
            )
        ]
        attempts = await session.scalars(
            select(ModelCall).where(ModelCall.run_id == run.id).order_by(ModelCall.started_at, ModelCall.id)
        )
        return RunSnapshot(
            id=run.id,
            goal=run.goal,
            status=RunStatus(run.status),
            provider=run.provider,
            model=run.model,
            reference_time=run.reference_time,
            business_timezone=run.business_timezone,
            step_count=run.step_count,
            tool_call_count=run.tool_call_count,
            total_tokens=run.total_tokens,
            estimated_cost_usd=str(run.estimated_cost_usd) if run.estimated_cost_usd is not None else None,
            model_calls=[ModelAttemptSnapshot.model_validate(a, from_attributes=True) for a in attempts],
            token_usage_complete=run.token_usage_complete,
            cost_is_upper_bound=run.cost_is_upper_bound,
            active_elapsed_ms=run.active_elapsed_ms,
            max_agent_steps=run.max_agent_steps,
            max_tool_calls=run.max_tool_calls,
            created_at=run.created_at,
            updated_at=run.updated_at,
            messages=messages,
            approvals=approvals,
            events=events,
            pending_approval=next((a for a in approvals if a.status == ApprovalStatus.pending), None),
            snapshot_cursor=run.next_event_sequence - 1,
        )
