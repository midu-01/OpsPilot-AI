"""Who is calling: turn `Authorization: Bearer <token>` into a user, or answer 401.

The console's Next.js server sends the token it keeps in an HttpOnly cookie; the browser never sees it.
"""

from collections.abc import Awaitable, Callable
from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import service
from app.db import get_session
from app.models import User

type DbSession = Annotated[AsyncSession, Depends(get_session)]
type UserLookup = Callable[[AsyncSession], Awaitable[User | None]]

# auto_error=False lets a missing header reach our code, so every kind of failure gets the same 401 below.
bearer_scheme = HTTPBearer(auto_error=False)
type BearerCredentials = Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)]


def not_authenticated() -> HTTPException:
    """One 401 for a missing, unknown, expired or revoked token; WWW-Authenticate says how to authenticate."""
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Not authenticated",
        headers={"WWW-Authenticate": "Bearer"},
    )


async def get_bearer_token(credentials: BearerCredentials) -> str:
    if credentials is None:
        raise not_authenticated()
    return credentials.credentials


type BearerToken = Annotated[str, Depends(get_bearer_token)]


async def get_current_user(token: BearerToken, session: DbSession) -> User:
    """Return the signed-in user.

    The lookup gets its own transaction, so the run services can call session.begin() on the same request
    session afterwards (FastAPI hands every dependency of one request the same session).
    """
    async with session.begin():
        user = await service.user_for_token(session, token)
    if user is None:
        raise not_authenticated()
    return user


type CurrentUser = Annotated[User, Depends(get_current_user)]


async def get_user_lookup(credentials: BearerCredentials) -> UserLookup:
    """For the run stream, which outlives its handshake: find the caller's user now, and again at every wake-up.

    It never raises. The WebSocket route accepts first and answers a missing, expired or revoked sign-in with a
    close code, because a browser cannot read the HTTP status of a refused handshake.
    """
    token = None if credentials is None else credentials.credentials

    async def find_user(session: AsyncSession) -> User | None:
        return None if token is None else await service.user_for_token(session, token)

    return find_user


type CallerLookup = Annotated[UserLookup, Depends(get_user_lookup)]
