"""Sign in, sign out and "who am I", called by the console's server (backend-for-frontend), never the browser."""

import math

from fastapi import APIRouter, HTTPException, Response, status

from app.auth import service
from app.auth.dependencies import BearerCredentials, CurrentUser, DbSession
from app.auth.schemas import LoginRequest, LoginResponse, UserPublic
from app.auth.throttle import LoginThrottle
from app.config import settings

router = APIRouter(prefix="/auth", tags=["auth"])
# Module-level on purpose: one process serves the API, so this one object sees every sign-in attempt.
login_throttle = LoginThrottle(settings.login_max_failures, settings.login_window_seconds)


def invalid_credentials() -> HTTPException:
    """The same answer for an unknown email and a wrong password, so the API never confirms an account exists."""
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid email or password",
        headers={"WWW-Authenticate": "Bearer"},
    )


def too_many_attempts(retry_after: int) -> HTTPException:
    minutes = math.ceil(retry_after / 60)
    unit = "minute" if minutes == 1 else "minutes"
    return HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail=f"Too many sign-in attempts. Try again in {minutes} {unit}.",
        headers={"Retry-After": str(retry_after)},
    )


@router.post(
    "/login",
    responses={
        status.HTTP_401_UNAUTHORIZED: {"description": "Unknown email or wrong password (one shared message)"},
        status.HTTP_429_TOO_MANY_REQUESTS: {"description": "Too many failed attempts; see Retry-After"},
    },
)
async def login(body: LoginRequest, session: DbSession) -> LoginResponse:
    """Exchange an email and password for a new bearer token."""
    retry_after = login_throttle.retry_after(body.email)
    if retry_after is not None:
        raise too_many_attempts(retry_after)
    # Count the attempt as failed before the slow password check (no await in between), so a burst of parallel
    # guesses cannot all pass the check above. A correct password clears the email's failures again.
    login_throttle.record_failure(body.email)
    user = await service.authenticate(session, body.email, body.password.get_secret_value())
    if user is None:
        raise invalid_credentials()
    login_throttle.reset(body.email)
    async with session.begin():
        token, expires_at = await service.start_session(session, user)
    return LoginResponse(access_token=token, expires_at=expires_at, user=UserPublic.model_validate(user))


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(session: DbSession, credentials: BearerCredentials) -> Response:
    """Revoke the bearer token if one was sent. Always 204, so signing out twice is harmless."""
    if credentials is not None:
        async with session.begin():
            await service.end_session(session, credentials.credentials)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/me")
async def me(user: CurrentUser) -> UserPublic:
    """The signed-in user, or 401 when the token is missing, unknown, expired or revoked."""
    return UserPublic.model_validate(user)
