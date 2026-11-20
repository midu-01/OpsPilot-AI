"""FastAPI entry point and health checks."""

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Response, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.config import settings
from app.db import engine
from app.runs.routes import router as runs_router
from app.runs.schemas import HealthResponse

logger = logging.getLogger("opspilot")
READINESS_TIMEOUT_SECONDS = 3.0


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    try:
        yield
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
app.include_router(runs_router)


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
