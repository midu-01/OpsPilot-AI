"""Check passwords and store sign-in sessions.

A session is a random token held by the client; the database keeps only its SHA-256 (see tokens.py), an absolute
expiry and an optional revocation time. authenticate opens its own short transaction; the other functions run in
the caller's transaction (the SSE stream calls user_for_token inside the session it already has open).
"""

import asyncio
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import passwords, tokens
from app.config import settings
from app.models import User, UserSession


async def authenticate(session: AsyncSession, email: str, password: str) -> User | None:
    """Return the user whose password matches, else None. Unknown emails cost as much as wrong passwords.

    The lookup commits before argon2 runs, so no database connection sits idle during the ~50 ms check, and the
    check runs in a worker thread so the event loop keeps serving SSE streams and the agent worker meanwhile.
    """
    async with session.begin():
        user = await session.scalar(select(User).where(User.email == email))
    if user is None:
        await asyncio.to_thread(passwords.verify_dummy, password)
        return None
    if not await asyncio.to_thread(passwords.verify_password, user.password_hash, password):
        return None
    return user


async def start_session(session: AsyncSession, user: User) -> tuple[str, datetime]:
    """Store a new session for the user; return its token (never stored) and when it expires."""
    token = tokens.new_token()
    expires_at = datetime.now(UTC) + timedelta(hours=settings.session_ttl_hours)
    session.add(UserSession(user_id=user.id, token_hash=tokens.hash_token(token), expires_at=expires_at))
    await session.flush()
    return token, expires_at


async def user_for_token(session: AsyncSession, token: str) -> User | None:
    """Return the token's user while its session is neither expired nor revoked."""
    user = await session.scalar(
        select(User)
        .join(UserSession, UserSession.user_id == User.id)
        .where(
            UserSession.token_hash == tokens.hash_token(token),
            UserSession.revoked_at.is_(None),
            UserSession.expires_at > datetime.now(UTC),
        )
    )
    return user


async def end_session(session: AsyncSession, token: str) -> None:
    """Revoke the token's session if it is still active. Revoking twice changes nothing."""
    await session.execute(
        update(UserSession)
        .where(UserSession.token_hash == tokens.hash_token(token), UserSession.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
    )
