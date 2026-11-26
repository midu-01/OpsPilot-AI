"""Every /runs endpoint needs a signed-in user, and each user only ever sees and controls their own runs.

The HTTP routes answer 401 and 404; the run stream, a WebSocket, closes with 4401 and 4404 instead.
"""

from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from uuid import UUID, uuid4

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models import Approval, Run, User
from tests.integration.stream_client import open_stream, read_until_closed
from tests.integration.test_approvals_api import proposal

type MakeUser = Callable[..., Awaitable[User]]
type AuthHeaders = Callable[[User], Awaitable[dict[str, str]]]

RUN_ENDPOINTS = [
    ("POST", "/runs", {"goal": "Find late shipments"}),
    ("GET", "/runs", None),
    ("GET", "/runs/{run_id}", None),
    ("POST", "/runs/{run_id}/approve", {"approval_id": str(uuid4()), "decision": "approve"}),
    ("POST", "/runs/{run_id}/stop", None),
]


async def test_every_runs_endpoint_needs_sign_in(
    api_client: AsyncClient, sessions: async_sessionmaker[AsyncSession], user: User
) -> None:
    run_id, _ = await proposal(sessions, user.id)  # a real run, so a 404 could not hide a missing 401
    for headers in ({}, {"Authorization": "Bearer not-a-session"}):
        for method, path, body in RUN_ENDPOINTS:
            response = await api_client.request(method, path.format(run_id=run_id), json=body, headers=headers)
            assert response.status_code == 401, (method, path, headers)
            assert response.json() == {"detail": "Not authenticated"}
            assert response.headers["www-authenticate"] == "Bearer"


async def test_the_run_stream_needs_sign_in(
    server: str, sessions: async_sessionmaker[AsyncSession], user: User
) -> None:
    run_id, _ = await proposal(sessions, user.id)
    for headers in ({}, {"Authorization": "Bearer not-a-session"}):
        async with open_stream(server, run_id, headers) as stream:
            received = await read_until_closed(stream)
        assert received.messages == [], headers  # not even "ready"
        assert (received.close_code, received.close_reason) == (4401, "Not authenticated")


async def test_creating_a_run_makes_the_caller_its_owner(
    api_client: AsyncClient, sessions: async_sessionmaker[AsyncSession], user: User, user_headers: dict[str, str]
) -> None:
    response = await api_client.post("/runs", json={"goal": "Find late shipments"}, headers=user_headers)
    assert response.status_code == 202
    async with sessions() as session:
        run = await session.get_one(Run, UUID(response.json()["id"]))
    assert run.user_id == user.id


async def test_users_list_only_their_own_runs(
    api_client: AsyncClient, make_user: MakeUser, auth_headers: AuthHeaders, sessions: async_sessionmaker[AsyncSession]
) -> None:
    alex, sam = await make_user(email="alex@opspilot.test"), await make_user(email="sam@opspilot.test")
    alex_headers, sam_headers = await auth_headers(alex), await auth_headers(sam)
    alex_runs = [
        (await api_client.post("/runs", json={"goal": f"Alex goal {n}"}, headers=alex_headers)).json()["id"]
        for n in range(3)
    ]
    sam_run = (await api_client.post("/runs", json={"goal": "Sam goal"}, headers=sam_headers)).json()["id"]
    async with sessions.begin() as session:
        session.add(  # a run from before accounts existed: nobody sees it until the seed adopts it
            Run(goal="Legacy", provider="fake", model="m", reference_time=datetime.now(UTC), business_timezone="UTC")
        )

    alex_page = (await api_client.get("/runs?page=1&page_size=2", headers=alex_headers)).json()
    assert alex_page["total"] == 3
    assert [item["id"] for item in alex_page["items"]] == alex_runs[:0:-1]  # newest first
    alex_last = (await api_client.get("/runs?page=2&page_size=2", headers=alex_headers)).json()
    assert [item["id"] for item in alex_last["items"]] == alex_runs[:1]
    sam_page = (await api_client.get("/runs", headers=sam_headers)).json()
    assert sam_page["total"] == 1
    assert [item["id"] for item in sam_page["items"]] == [sam_run]


async def test_another_users_run_looks_missing_on_every_run_route(
    api_client: AsyncClient,
    server: str,
    make_user: MakeUser,
    auth_headers: AuthHeaders,
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    alex, sam = await make_user(email="alex@opspilot.test"), await make_user(email="sam@opspilot.test")
    alex_headers, sam_headers = await auth_headers(alex), await auth_headers(sam)
    run_id, approval_id = await proposal(sessions, alex.id)  # awaiting approval, with a pending proposal
    approve = {"approval_id": str(approval_id), "decision": "approve"}

    for method, suffix, body in [("GET", "", None), ("POST", "/approve", approve)]:
        response = await api_client.request(method, f"/runs/{run_id}{suffix}", json=body, headers=sam_headers)
        assert response.status_code == 404
        assert response.json() == {"detail": "Run not found"}
    stop = await api_client.post(f"/runs/{run_id}/stop", headers=sam_headers)
    assert stop.status_code == 404 and stop.json() == {"detail": "Run not found"}
    async with open_stream(server, run_id, sam_headers) as stream:
        streamed = await read_until_closed(stream)
    assert streamed.messages == []
    assert (streamed.close_code, streamed.close_reason) == (4404, "Run not found")

    # Sam's attempts changed nothing; Alex can still see and decide the proposal.
    async with sessions() as session:
        run, approval = await session.get_one(Run, run_id), await session.get_one(Approval, approval_id)
    assert (run.status, run.cancellation_requested, approval.status) == ("awaiting_approval", False, "pending")
    snapshot = await api_client.get(f"/runs/{run_id}", headers=alex_headers)
    assert snapshot.status_code == 200 and snapshot.json()["pending_approval"]["id"] == str(approval_id)
    decided = await api_client.post(f"/runs/{run_id}/approve", json=approve, headers=alex_headers)
    assert decided.status_code == 200 and decided.json()["status"] == "queued"


async def test_runs_without_an_owner_are_visible_to_nobody(
    api_client: AsyncClient, server: str, sessions: async_sessionmaker[AsyncSession], user_headers: dict[str, str]
) -> None:
    legacy = Run(goal="Legacy", provider="fake", model="m", reference_time=datetime.now(UTC), business_timezone="UTC")
    async with sessions.begin() as session:
        session.add(legacy)
    response = await api_client.get(f"/runs/{legacy.id}", headers=user_headers)
    assert response.status_code == 404
    assert (await api_client.post(f"/runs/{legacy.id}/stop", headers=user_headers)).status_code == 404
    async with open_stream(server, legacy.id, user_headers) as stream:
        assert (await read_until_closed(stream)).close_code == 4404
