"""Create queued runs and read their persisted traces."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.runs import service
from app.runs.schemas import PaginatedRuns, RunCreate, RunSnapshot, RunSummary

router = APIRouter(prefix="/runs", tags=["runs"])
type Session = Annotated[AsyncSession, Depends(get_session)]


@router.post("", status_code=202)
async def create_run(body: RunCreate, session: Session) -> RunSummary:
    return await service.create_run(session, body.goal)


@router.get("")
async def list_runs(
    session: Session,
    page: Annotated[int, Query(ge=1, le=2147483647)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
) -> PaginatedRuns:
    return await service.list_runs(session, page, page_size)


@router.get("/{run_id}")
async def get_run(run_id: UUID, session: Session) -> RunSnapshot:
    snapshot = await service.get_snapshot(session, run_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return snapshot
