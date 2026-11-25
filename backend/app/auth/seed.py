"""Demo accounts: two users who share the password from DEMO_USER_PASSWORD.

Runs created before accounts existed have no owner, and every runs query filters by owner, so nobody could see
them. The seed gives them to the first demo user, so an upgraded database keeps its history visible.
"""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.passwords import hash_password, needs_rehash, verify_password
from app.models import Run, User, UserSession

DEMO_USERS = (("alex@opspilot.test", "Alex Rivera"), ("sam@opspilot.test", "Sam Chen"))


async def seed_demo_users(session: AsyncSession, password: str) -> list[User]:
    """Create or update the demo users, then adopt ownerless runs. Runs in the caller's transaction.

    Safe to repeat: existing users keep their id and runs, and a hash is replaced only when it no longer matches
    the configured password or uses weaker argon2 settings. The seed is its own process, so hashing inline is fine.
    """
    if not password:
        print(
            "Skipped the demo users: set DEMO_USER_PASSWORD to create "
            + " and ".join(email for email, _ in DEMO_USERS)
            + "."
        )
        return []
    users = [await ensure_user(session, email, display_name, password) for email, display_name in DEMO_USERS]
    adopted = await adopt_ownerless_runs(session, users[0].id)
    print(
        f"Demo users ready: {', '.join(user.email for user in users)}. "
        f"Runs without an owner given to {users[0].email}: {adopted}."
    )
    return users


async def ensure_user(session: AsyncSession, email: str, display_name: str, password: str) -> User:
    user = await session.scalar(select(User).where(User.email == email))
    if user is None:
        user = User(email=email, display_name=display_name, password_hash=hash_password(password))
        session.add(user)
        await session.flush()
    elif not verify_password(user.password_hash, password):
        # The configured password changed: sessions signed in with the old one must end too.
        user.password_hash = hash_password(password)
        await end_all_sessions(session, user.id)
    elif needs_rehash(user.password_hash):
        user.password_hash = hash_password(password)  # same password, stronger argon2 settings
    return user


async def end_all_sessions(session: AsyncSession, user_id: UUID) -> None:
    await session.execute(
        update(UserSession)
        .where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
    )


async def adopt_ownerless_runs(session: AsyncSession, owner_id: UUID) -> int:
    """Give every run without an owner to owner_id and return how many there were."""
    adopted = await session.scalars(update(Run).where(Run.user_id.is_(None)).values(user_id=owner_id).returning(Run.id))
    return len(adopted.all())
