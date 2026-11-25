"""Test accounts created straight in the database; the login endpoint has its own tests in test_auth_api.py."""

from uuid import uuid4

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.auth.passwords import hash_password
from app.auth.service import start_session
from app.models import User

TEST_PASSWORD = "correct-horse-battery-staple"
# Argon2 is slow on purpose, so hash once for every test account.
TEST_PASSWORD_HASH = hash_password(TEST_PASSWORD)


async def create_user(
    sessions: async_sessionmaker[AsyncSession], email: str | None = None, display_name: str = "Test User"
) -> User:
    """Add an account whose password is TEST_PASSWORD; a random email keeps several users in one test apart."""
    user = User(
        email=email or f"user-{uuid4().hex[:12]}@opspilot.test",
        display_name=display_name,
        password_hash=TEST_PASSWORD_HASH,
    )
    async with sessions.begin() as session:
        session.add(user)
    return user


async def bearer_headers(sessions: async_sessionmaker[AsyncSession], user: User) -> dict[str, str]:
    """Start a session for the user, as a successful login would, and return its Authorization header."""
    async with sessions.begin() as session:
        token, _ = await start_session(session, user)
    return {"Authorization": f"Bearer {token}"}
