"""Create queued runs and read their persisted traces, for the signed-in owner only."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import CurrentUser, get_current_user
from app.db import get_session
from app.models import Run
from app.runs import decisions, service
from app.runs.schemas import ApprovalAction, PaginatedRuns, RunCreate, RunSnapshot, RunSummary

# Router-level, so every HTTP route under /runs needs a signed-in user, including any route added later.
# FastAPI runs a dependency once per request, so routes that also ask for CurrentUser get the same user.
# The live stream is a WebSocket on its own router (app/runs/websocket.py): it makes the same checks itself,
# after accepting, because a refused handshake cannot tell the browser why.
router = APIRouter(prefix="/runs", tags=["runs"], dependencies=[Depends(get_current_user)])
type Session = Annotated[AsyncSession, Depends(get_session)]


async def require_run_owner(run_id: UUID, user: CurrentUser, session: Session) -> None:
    """404 unless the signed-in user owns the run, so someone else's run looks exactly like a missing one.

    Owners never change, so one check before the route runs is enough. The read gets its own transaction
    because the run services call session.begin() themselves.
    """
    async with session.begin():
        owner_id = await session.scalar(select(Run.user_id).where(Run.id == run_id))
    if owner_id != user.id:  # also true when the run does not exist or has no owner
        raise HTTPException(status_code=404, detail="Run not found")


OWNER_ONLY = [Depends(require_run_owner)]


@router.post("", status_code=202)
async def create_run(body: RunCreate, session: Session, user: CurrentUser) -> RunSummary:
    return await service.create_run(session, user.id, body.goal)


@router.get("")
async def list_runs(
    session: Session,
    user: CurrentUser,
    page: Annotated[int, Query(ge=1, le=2147483647)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
) -> PaginatedRuns:
    return await service.list_runs(session, user.id, page, page_size)


@router.get("/{run_id}", dependencies=OWNER_ONLY)
async def get_run(run_id: UUID, session: Session) -> RunSnapshot:
    snapshot = await service.get_snapshot(session, run_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return snapshot


@router.post("/{run_id}/approve", dependencies=OWNER_ONLY)
async def decide_approval(run_id: UUID, body: ApprovalAction, session: Session) -> RunSummary:
    return await decisions.decide_approval(session, run_id, body)


@router.post("/{run_id}/stop", dependencies=OWNER_ONLY)
async def stop_run(run_id: UUID, session: Session) -> RunSummary:
    return await decisions.stop_run(session, run_id)
