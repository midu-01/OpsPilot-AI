"""Sign-in, sessions and sign-out through the HTTP API."""

import asyncio
import hashlib
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.auth import passwords
from app.auth import routes as auth_routes
from app.auth.throttle import LoginThrottle
from app.auth.tokens import hash_token
from app.models import User, UserSession
from tests.integration.accounts import TEST_PASSWORD

type MakeUser = Callable[..., Awaitable[User]]
type AuthHeaders = Callable[[User], Awaitable[dict[str, str]]]
ALEX = "alex@opspilot.test"


class FakeClock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


@pytest.fixture(autouse=True)
def clock(monkeypatch: pytest.MonkeyPatch) -> FakeClock:
    """Every test starts with no failed sign-ins and a throttle clock it controls (5 per email, 50 overall)."""
    fake = FakeClock()
    monkeypatch.setattr(auth_routes, "login_throttle", LoginThrottle(5, 900, clock=fake))
    return fake


async def login(client: AsyncClient, email: str, password: str) -> Response:
    return await client.post("/auth/login", json={"email": email, "password": password})


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def test_login_returns_a_token_for_me_and_stores_only_its_hash(
    api_client: AsyncClient, make_user: MakeUser, sessions: async_sessionmaker[AsyncSession]
) -> None:
    alex = await make_user(email=ALEX, display_name="Alex Rivera")
    response = await login(api_client, "  Alex@OpsPilot.TEST ", TEST_PASSWORD)
    assert response.status_code == 200
    body = response.json()
    assert body["token_type"] == "bearer"
    assert body["user"] == {"id": str(alex.id), "email": ALEX, "display_name": "Alex Rivera"}
    lifetime = datetime.fromisoformat(body["expires_at"]) - datetime.now(UTC)
    assert timedelta(hours=11, minutes=59) < lifetime <= timedelta(hours=12)
    assert "password_hash" not in response.text and "argon2" not in response.text

    me = await api_client.get("/auth/me", headers=bearer(body["access_token"]))
    assert me.status_code == 200
    assert me.json() == body["user"]
    async with sessions() as session:
        stored = await session.scalar(select(UserSession.token_hash))
    assert stored == hashlib.sha256(body["access_token"].encode()).hexdigest()


async def test_wrong_password_and_unknown_email_get_the_same_401(api_client: AsyncClient, make_user: MakeUser) -> None:
    await make_user(email=ALEX)
    wrong_password = await login(api_client, ALEX, "not-the-password")
    unknown_email = await login(api_client, "nobody@opspilot.test", TEST_PASSWORD)
    for response in (wrong_password, unknown_email):
        assert response.status_code == 401
        assert response.json() == {"detail": "Invalid email or password"}
        assert response.headers["www-authenticate"] == "Bearer"


async def test_unknown_email_still_pays_for_a_password_check(
    api_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    checked: list[str] = []
    monkeypatch.setattr(passwords, "verify_dummy", checked.append)
    assert (await login(api_client, "nobody@opspilot.test", "a-guess")).status_code == 401
    assert checked == ["a-guess"]


async def test_rejected_login_bodies_never_echo_the_password(api_client: AsyncClient) -> None:
    rejected_bodies: list[dict[str, object]] = [
        {"email": ALEX, "password": "S3cret-" + "x" * 130},
        {"email": "not-an-email", "password": "S3cret-visible"},
        {"password": "S3cret-visible"},
        {"email": ALEX, "password": "S3cret-visible", "remember": "S3cret-visible"},
        {"email": ALEX, "password": ["S3cret-visible"]},
    ]
    for body in rejected_bodies:
        response = await api_client.post("/auth/login", json=body)
        assert response.status_code == 422, body
        assert "S3cret" not in response.text
        assert all(set(error) <= {"type", "loc", "msg"} for error in response.json()["detail"])


async def test_repeated_failures_are_throttled_until_the_window_passes(
    api_client: AsyncClient, make_user: MakeUser, clock: FakeClock
) -> None:
    await make_user(email=ALEX)
    for _ in range(5):
        assert (await login(api_client, ALEX, "wrong-password")).status_code == 401
    # Blocked even with the right password, and the email is matched after normalisation.
    blocked = await login(api_client, " ALEX@opspilot.test", TEST_PASSWORD)
    assert blocked.status_code == 429
    assert blocked.headers["retry-after"] == "900"
    assert blocked.json() == {"detail": "Too many sign-in attempts. Try again in 15 minutes."}
    # Other emails are not affected.
    assert (await login(api_client, "sam@opspilot.test", "wrong-password")).status_code == 401
    clock.advance(900)
    assert (await login(api_client, ALEX, TEST_PASSWORD)).status_code == 200


async def test_a_burst_of_parallel_guesses_gets_no_more_tries_than_the_limit(
    api_client: AsyncClient, make_user: MakeUser
) -> None:
    await make_user(email=ALEX)
    responses = await asyncio.gather(*(login(api_client, ALEX, f"guess-{n}") for n in range(10)))
    # Each attempt is counted before its slow password check, so parallel requests cannot all slip through.
    assert sorted(response.status_code for response in responses) == [401] * 5 + [429] * 5


async def test_a_successful_login_clears_that_emails_failures(api_client: AsyncClient, make_user: MakeUser) -> None:
    await make_user(email=ALEX)
    for _ in range(4):
        assert (await login(api_client, ALEX, "wrong-password")).status_code == 401
    assert (await login(api_client, ALEX, TEST_PASSWORD)).status_code == 200
    # Without the reset, the second of these would be the fifth failure in the window and get a 429.
    for _ in range(4):
        assert (await login(api_client, ALEX, "wrong-password")).status_code == 401


async def test_failures_spread_over_many_emails_hit_the_global_cap(
    api_client: AsyncClient, monkeypatch: pytest.MonkeyPatch, clock: FakeClock
) -> None:
    monkeypatch.setattr(auth_routes, "login_throttle", LoginThrottle(5, 900, global_max_failures=3, clock=clock))
    for index in range(3):
        assert (await login(api_client, f"user{index}@opspilot.test", "Spring2026!")).status_code == 401
        clock.advance(30)
    blocked = await login(api_client, "fresh@opspilot.test", "Spring2026!")
    assert blocked.status_code == 429
    assert blocked.headers["retry-after"] == str(900 - 90)
    assert blocked.json()["detail"] == "Too many sign-in attempts. Try again in 14 minutes."


async def test_me_needs_a_valid_bearer_token(api_client: AsyncClient) -> None:
    for headers in [{}, {"Authorization": "Bearer"}, {"Authorization": "Basic YWxleDpwdw=="}, bearer("unknown")]:
        response = await api_client.get("/auth/me", headers=headers)
        assert response.status_code == 401, headers
        assert response.json() == {"detail": "Not authenticated"}
        assert response.headers["www-authenticate"] == "Bearer"


async def test_expired_and_revoked_sessions_are_rejected(
    api_client: AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders, sessions: async_sessionmaker[AsyncSession]
) -> None:
    alex = await make_user(email=ALEX)
    expired, revoked, active = await auth_headers(alex), await auth_headers(alex), await auth_headers(alex)
    now = datetime.now(UTC)
    async with sessions.begin() as session:
        for headers, values in ((expired, {"expires_at": now - timedelta(seconds=1)}), (revoked, {"revoked_at": now})):
            token = headers["Authorization"].removeprefix("Bearer ")
            await session.execute(update(UserSession).where(UserSession.token_hash == hash_token(token)).values(values))
    for headers in (expired, revoked):
        response = await api_client.get("/auth/me", headers=headers)
        assert response.status_code == 401
        assert response.json() == {"detail": "Not authenticated"}
    assert (await api_client.get("/auth/me", headers=active)).status_code == 200


async def test_logout_revokes_only_that_token_and_is_idempotent(
    api_client: AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders
) -> None:
    alex = await make_user(email=ALEX)
    signed_out, other_device = await auth_headers(alex), await auth_headers(alex)
    assert (await api_client.post("/auth/logout", headers=signed_out)).status_code == 204
    assert (await api_client.get("/auth/me", headers=signed_out)).status_code == 401
    assert (await api_client.get("/auth/me", headers=other_device)).status_code == 200
    for headers in (signed_out, {}, {"Authorization": "Bearer unknown"}):
        response = await api_client.post("/auth/logout", headers=headers)
        assert response.status_code == 204
        assert response.content == b""
