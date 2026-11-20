from datetime import date
from pathlib import Path

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Order, SeedMetadata
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
