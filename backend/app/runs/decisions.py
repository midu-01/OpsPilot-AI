"""Serialize approval decisions and cancellation against run execution."""

from datetime import UTC, datetime
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Approval, Run, ToolCall
from app.runs.schemas import ApprovalAction, ApprovalDecision, ApprovalStatus, EventType, RunStatus, RunSummary
from app.runs.service import append_event

TERMINAL_STATUSES = {RunStatus.completed, RunStatus.failed, RunStatus.cancelled}


async def decide_approval(session: AsyncSession, run_id: UUID, action: ApprovalAction) -> RunSummary:
    """Persist a decision and wake the queue; the worker resumes the saved tool batch."""
    async with session.begin():
        run = await session.scalar(select(Run).where(Run.id == run_id).with_for_update())
        if run is None:
            raise HTTPException(status_code=404, detail="Run not found")
        approval = await session.scalar(
            select(Approval).where(Approval.id == action.approval_id, Approval.run_id == run_id).with_for_update()
        )
        if approval is None:
            raise HTTPException(status_code=404, detail="Approval not found")
        if run.status in {RunStatus.cancelling, RunStatus.cancelled} or run.cancellation_requested:
            raise HTTPException(status_code=409, detail="Run no longer accepts approval decisions")
        target = ApprovalStatus.approved if action.decision == ApprovalDecision.approve else ApprovalStatus.rejected
        if approval.status == target and approval.reason == action.reason:
            return RunSummary.model_validate(run, from_attributes=True)
        if run.status in TERMINAL_STATUSES:
            raise HTTPException(status_code=409, detail="Run no longer accepts approval decisions")
        if approval.status != ApprovalStatus.pending:
            raise HTTPException(status_code=409, detail="Approval already has a different decision")
        call = await session.get_one(ToolCall, approval.tool_call_id)
        if run.status != RunStatus.awaiting_approval or call.result is not None:
            raise HTTPException(status_code=409, detail="Approval is no longer pending execution")
        approval.status = target
        approval.reason = action.reason
        approval.decided_at = datetime.now(UTC)
        run.status = RunStatus.queued
        await append_event(
            session,
            run_id,
            EventType.approval_decided,
            {
                "approval_id": str(approval.id),
                "tool_call_id": str(approval.tool_call_id),
                "status": approval.status,
                "decision": action.decision,
                "reason": approval.reason,
            },
        )
        await append_event(session, run_id, EventType.run_queued, {"status": run.status})
        await session.refresh(run)
        return RunSummary.model_validate(run, from_attributes=True)


async def stop_run(session: AsyncSession, run_id: UUID) -> RunSummary:
    """Cancel parked work immediately or signal the worker to interrupt active execution."""
    async with session.begin():
        run = await session.scalar(select(Run).where(Run.id == run_id).with_for_update())
        if run is None:
            raise HTTPException(status_code=404, detail="Run not found")
        if run.status in TERMINAL_STATUSES or run.status == RunStatus.cancelling:
            return RunSummary.model_validate(run, from_attributes=True)
        was_running = run.status == RunStatus.running
        run.cancellation_requested = True
        run.status = RunStatus.cancelling
        pending = await session.scalars(
            select(Approval)
            .where(Approval.run_id == run_id, Approval.status == ApprovalStatus.pending)
            .order_by(Approval.id)
            .with_for_update()
        )
        for approval in pending:
            approval.status = ApprovalStatus.cancelled
            approval.decided_at = datetime.now(UTC)
            await append_event(
                session,
                run_id,
                EventType.approval_decided,
                {
                    "approval_id": str(approval.id),
                    "tool_call_id": str(approval.tool_call_id),
                    "status": approval.status,
                    "reason": "Run cancelled by user",
                },
            )
        if not was_running:
            # The worker owns active execution; parked work has no in-flight provider to interrupt.
            from app.agent.worker import finish_interrupted

            await finish_interrupted(session, run, "RUN_CANCELLED", "Run cancelled by user.")
        await session.flush()
        await session.refresh(run)
        return RunSummary.model_validate(run, from_attributes=True)
