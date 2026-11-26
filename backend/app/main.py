"""FastAPI entry point and health checks."""

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, Request, Response, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.agent.worker import run_worker
from app.auth.routes import router as auth_router
from app.config import settings
from app.db import async_session_factory, engine
from app.runs.routes import router as runs_router
from app.runs.schemas import HealthResponse
from app.runs.websocket import router as run_stream_router

logger = logging.getLogger("opspilot")
READINESS_TIMEOUT_SECONDS = 3.0


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    worker = asyncio.create_task(run_worker(engine, async_session_factory), name="opspilot-run-worker")
    try:
        yield
    finally:
        worker.cancel()
        try:
            with suppress(asyncio.CancelledError):
                await worker
        finally:
            await engine.dispose()


app = FastAPI(title="OpsPilot AI", description="Agent Run Console API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allowed_origins.split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(auth_router)
app.include_router(runs_router)
app.include_router(run_stream_router)

# FastAPI's default 422 body repeats each invalid value under "input" (and limits under "ctx"),
# which would echo a rejected password from POST /auth/login. Say which field failed and why, never what was sent.
VALIDATION_ERROR_KEYS = ("type", "loc", "msg")


@app.exception_handler(RequestValidationError)
async def validation_error_without_input(request: Request, exc: RequestValidationError) -> JSONResponse:
    errors = [{key: error[key] for key in VALIDATION_ERROR_KEYS if key in error} for error in exc.errors()]
    return JSONResponse(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, content={"detail": jsonable_encoder(errors)})


@app.get("/health/live", tags=["health"])
async def liveness() -> HealthResponse:
    """Check that the API process is running."""
    return HealthResponse(status="alive")


@app.get("/health/ready", tags=["health"], responses={503: {"model": HealthResponse}})
async def readiness(response: Response) -> HealthResponse:
    """Check PostgreSQL connectivity within the health probe deadline."""
    try:
        async with asyncio.timeout(READINESS_TIMEOUT_SECONDS), engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception as exc:
        logger.warning("Database readiness check failed (%s)", type(exc).__name__)
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return HealthResponse(status="unavailable", details={"database": "unavailable"})
    return HealthResponse(status="ready", details={"database": "connected"})
