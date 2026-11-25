"""Create queued runs and read their persisted traces, for the signed-in owner only."""

from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import CurrentUser, StillSignedIn, get_current_user
from app.db import get_session, get_session_factory
from app.models import Run
from app.runs import decisions, events, service
from app.runs.schemas import ApprovalAction, PaginatedRuns, RunCreate, RunSnapshot, RunSummary

# Router-level, so every /runs route needs a signed-in user, including any route added later.
# FastAPI runs a dependency once per request, so routes that also ask for CurrentUser get the same user.
router = APIRouter(prefix="/runs", tags=["runs"], dependencies=[Depends(get_current_user)])
type Session = Annotated[AsyncSession, Depends(get_session)]


def parse_cursor(last_event_id: str | None, after: str | None) -> int:
    raw_cursor: str | None = None
    if last_event_id is not None:
        raw_cursor = last_event_id
    elif after is not None:
        raw_cursor = after

    if raw_cursor is None:
        return 0

    try:
        cursor = int(raw_cursor)
    except (ValueError, TypeError):
        raise HTTPException(status_code=422, detail="Invalid event cursor; expected an integer") from None

    if cursor < 0:
        raise HTTPException(status_code=422, detail="Cursor must be non-negative")

    return cursor


def make_session_opener(request: Request) -> Callable[[], AbstractAsyncContextManager[AsyncSession]]:
    @asynccontextmanager
    async def open_session() -> AsyncIterator[AsyncSession]:
        override_sess = request.app.dependency_overrides.get(get_session)
        if override_sess:
            gen = override_sess()
            if hasattr(gen, "__aenter__"):
                async with gen as session:
                    yield session
            elif hasattr(gen, "__anext__"):
                session = await anext(gen)
                try:
                    yield session
                finally:
                    await gen.aclose()
            else:
                yield override_sess()
            return

        override_factory = request.app.dependency_overrides.get(get_session_factory)
        factory = override_factory() if override_factory else get_session_factory()
        async with factory() as session:
            yield session

    return open_session


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


@router.get("/{run_id}/stream", dependencies=OWNER_ONLY)
async def stream_run(
    run_id: UUID,
    request: Request,
    still_signed_in: StillSignedIn,
    after: Annotated[str | None, Query(description="Sequence number to replay events after")] = None,
    last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
) -> Response:
    cursor = parse_cursor(last_event_id, after)
    opener = make_session_opener(request)

    async with opener() as session:
        stream_info = await events.get_run_stream_info(session, run_id)

    if stream_info is None:
        raise HTTPException(status_code=404, detail="Run not found")

    status, latest_seq = stream_info

    if cursor > latest_seq:
        raise HTTPException(status_code=422, detail="Cursor is ahead of the run's latest sequence")

    if status in events.TERMINAL_STATUSES and cursor >= latest_seq:
        return Response(status_code=204)

    return StreamingResponse(
        # A sign-out ends the open stream too: it re-checks the token on every wake-up (at least every 15 s).
        events.stream_events(opener, run_id, cursor, is_authorized=still_signed_in),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
