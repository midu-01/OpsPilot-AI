"""Phase 1 run routes pending the persistence layer."""

from typing import Annotated, Never

from fastapi import APIRouter, HTTPException, Query

from app.runs.schemas import PaginatedRuns, RunCreate, RunSummary

router = APIRouter(prefix="/runs", tags=["runs"])


@router.post("", status_code=202, response_model=RunSummary)
async def create_run(body: RunCreate) -> Never:
    raise HTTPException(status_code=501, detail="Run creation not yet implemented")


@router.get("")
async def list_runs(
    page: Annotated[int, Query(ge=1)] = 1, page_size: Annotated[int, Query(ge=1)] = 20
) -> PaginatedRuns:
    return PaginatedRuns(items=[], total=0, page=page, page_size=page_size)
