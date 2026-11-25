from datetime import UTC, date, datetime
from pathlib import Path

import pytest
from argon2 import PasswordHasher
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.passwords import needs_rehash, verify_password
from app.auth.seed import DEMO_USERS, seed_demo_users
from app.auth.service import start_session, user_for_token
from app.models import Order, Run, SeedMetadata, User
from app.seed import SEED_KEY, seed_orders


@pytest.fixture
async def seed_data(db_session: AsyncSession) -> date:
    async with db_session.begin():
        return await seed_orders(db_session, date(2028, 3, 15))


async def test_seed_is_stable_across_months_and_preserves_edits(db_session: AsyncSession, seed_data: date) -> None:
    async with db_session.begin():
        order = await db_session.get_one(Order, "ORD-1001")
        assert order.shipped_at and order.shipped_at.date() == date(2028, 2, 1)
        assert order.shipped_at > order.promised_ship_at
        order.customer_name = "Existing record"

    async with db_session.begin():
        actual = await seed_orders(db_session, date(2029, 1, 1))
        assert actual == seed_data
        assert (await db_session.get_one(SeedMetadata, SEED_KEY)).reference_date == seed_data
        assert await db_session.scalar(select(func.count()).select_from(Order)) == 30
        await db_session.refresh(order)
        assert order.customer_name == "Existing record"


def test_policy_corpus_covers_eight_distinct_topics() -> None:
    policies = Path(__file__).resolve().parents[2] / "policies"
    assert len(list(policies.glob("*.md"))) == 8
    assert "half cents rounded up" in (policies / "03-refund-amount.md").read_text()


async def test_reseed_preserves_existing_refund_and_its_run(db_session: AsyncSession, seed_data: date) -> None:
    from datetime import UTC, datetime

    from app.models import Approval, Message, Refund, Run, ToolCall

    async with db_session.begin():
        run = Run(
            goal="Existing adjustment",
            provider="fake",
            model="fixture",
            status="completed",
            reference_time=datetime.now(UTC),
            business_timezone="UTC",
        )
        db_session.add(run)
        await db_session.flush()
        message = Message(run_id=run.id, index=0, role="assistant")
        db_session.add(message)
        await db_session.flush()
        call = ToolCall(
            run_id=run.id,
            message_id=message.id,
            provider_call_id="fixture-call",
            name="issue_refund",
            arguments={"order_id": "ORD-1001"},
            status="completed",
        )
        db_session.add(call)
        await db_session.flush()
        approval = Approval(
            run_id=run.id,
            tool_call_id=call.id,
            proposed_arguments=call.arguments,
            arguments_digest="fixture",
            status="approved",
            decided_at=datetime.now(UTC),
        )
        db_session.add(approval)
        await db_session.flush()
        ledger = Refund(
            order_id="ORD-1001",
            tool_call_id=call.id,
            policy_version="v1",
            amount_minor=6250,
            currency="USD",
            reason="Late shipment",
        )
        db_session.add(ledger)

    async with db_session.begin():
        await seed_orders(db_session, date(2030, 1, 1))
        await db_session.refresh(ledger)
        await db_session.refresh(run)
        assert ledger.amount_minor == 6250 and ledger.tool_call_id == call.id
        assert run.status == "completed"


def legacy_run(user_id: object = None) -> Run:
    return Run(
        goal="Run from before accounts",
        provider="fake",
        model="fixture",
        reference_time=datetime.now(UTC),
        business_timezone="UTC",
        user_id=user_id,
    )


async def test_demo_users_are_created_once_and_adopt_ownerless_runs(
    db_session: AsyncSession, capsys: pytest.CaptureFixture[str]
) -> None:
    async with db_session.begin():
        db_session.add_all([legacy_run(), legacy_run()])
    async with db_session.begin():
        users = await seed_demo_users(db_session, "opspilot-demo")
    assert [(user.email, user.display_name) for user in users] == list(DEMO_USERS)
    assert all(verify_password(user.password_hash, "opspilot-demo") for user in users)
    output = capsys.readouterr().out
    assert "Runs without an owner given to alex@opspilot.test: 2." in output
    assert "opspilot-demo" not in output

    async with db_session.begin():
        sam_run = legacy_run(users[1].id)
        db_session.add_all([sam_run, legacy_run()])
    hashes = [user.password_hash for user in users]
    async with db_session.begin():
        again = await seed_demo_users(db_session, "opspilot-demo")
        owners = list(await db_session.scalars(select(Run.user_id).order_by(Run.created_at)))
        user_count = await db_session.scalar(select(func.count()).select_from(User))
    assert [user.id for user in again] == [user.id for user in users]
    assert [user.password_hash for user in again] == hashes  # still valid, so not re-hashed
    assert user_count == 2
    # Only the new ownerless run moved to Alex; Sam's run stayed Sam's.
    assert sorted(map(str, owners)) == sorted(map(str, [users[0].id] * 3 + [users[1].id]))
    assert "Runs without an owner given to alex@opspilot.test: 1." in capsys.readouterr().out


async def test_seed_replaces_hashes_that_no_longer_match_or_are_too_weak(db_session: AsyncSession) -> None:
    async with db_session.begin():
        await seed_demo_users(db_session, "old-password")
    async with db_session.begin():
        changed = await seed_demo_users(db_session, "new-password")
    assert all(verify_password(user.password_hash, "new-password") for user in changed)
    assert not any(verify_password(user.password_hash, "old-password") for user in changed)

    weak = PasswordHasher(time_cost=1, memory_cost=8192, parallelism=1).hash("new-password")
    async with db_session.begin():
        changed[0].password_hash = weak
    async with db_session.begin():
        upgraded = await seed_demo_users(db_session, "new-password")
    assert upgraded[0].password_hash != weak
    assert not needs_rehash(upgraded[0].password_hash)
    assert verify_password(upgraded[0].password_hash, "new-password")


async def test_a_changed_demo_password_ends_sessions_but_a_rehash_does_not(db_session: AsyncSession) -> None:
    async with db_session.begin():
        alex, sam = await seed_demo_users(db_session, "old-password")
        old_token, _ = await start_session(db_session, alex)
    async with db_session.begin():
        await seed_demo_users(db_session, "new-password")
    async with db_session.begin():
        assert await user_for_token(db_session, old_token) is None  # signed in with the old password

    async with db_session.begin():
        current_token, _ = await start_session(db_session, sam)
        sam.password_hash = PasswordHasher(time_cost=1, memory_cost=8192, parallelism=1).hash("new-password")
    async with db_session.begin():
        await seed_demo_users(db_session, "new-password")  # same password, stronger hash only
    async with db_session.begin():
        assert await user_for_token(db_session, current_token) is not None


async def test_seed_skips_demo_users_without_a_password(
    db_session: AsyncSession, capsys: pytest.CaptureFixture[str]
) -> None:
    async with db_session.begin():
        db_session.add(legacy_run())
    async with db_session.begin():
        assert await seed_demo_users(db_session, "") == []
        assert await db_session.scalar(select(func.count()).select_from(User)) == 0
        assert await db_session.scalar(select(Run.user_id)) is None
    assert "set DEMO_USER_PASSWORD" in capsys.readouterr().out
