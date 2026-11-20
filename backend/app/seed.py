"""Initialize the versioned local order fixtures without overwriting existing records."""

import argparse
import asyncio
from calendar import monthrange
from datetime import UTC, date, datetime, time, timedelta

from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import async_session_factory, engine
from app.models import Order, SeedMetadata

SEED_KEY = "demo-orders-v1"


def previous_month(reference: date) -> tuple[date, date]:
    end = reference.replace(day=1)
    return (end - timedelta(days=1)).replace(day=1), end


def demo_orders(reference: date) -> list[Order]:
    first, end = previous_month(reference)
    days = monthrange(first.year, first.month)[1]
    orders = []
    for index in range(30):
        # Include exact month boundaries, the preceding day, and interior days.
        day = (first, end, first - timedelta(days=1))[index] if index < 3 else first + timedelta(days=index % days)
        shipped = datetime.combine(day, time.min if index < 3 else time(12), tzinfo=UTC)
        delay_days = (2, 1, 1, 0, -1, 3)[index % 6]
        status = {8: "cancelled", 14: "refunded", 20: "pending"}.get(index, "shipped")
        orders.append(
            Order(
                id=f"ORD-{1001 + index}",
                customer_name=f"Demo Customer {index + 1:02}",
                customer_email=f"customer{index + 1:02}@example.test",
                amount_minor=(62500, 49999, 50000, 50001, 108000, 84505)[index % 6],
                currency="USD",
                status=status,
                promised_ship_at=shipped - timedelta(days=delay_days),
                shipped_at=None if status in {"pending", "cancelled"} else shipped,
            )
        )
    return orders


async def seed_orders(session: AsyncSession, reference: date) -> date:
    """Use the date chosen by the first initializer; commit in the caller's transaction."""
    await session.execute(
        insert(SeedMetadata)
        .values(key=SEED_KEY, reference_date=reference)
        .on_conflict_do_nothing(index_elements=[SeedMetadata.key])
    )
    metadata = await session.get_one(SeedMetadata, SEED_KEY)
    columns = (
        "id",
        "customer_name",
        "customer_email",
        "amount_minor",
        "currency",
        "status",
        "promised_ship_at",
        "shipped_at",
    )
    values = [{field: getattr(order, field) for field in columns} for order in demo_orders(metadata.reference_date)]
    await session.execute(insert(Order).values(values).on_conflict_do_nothing(index_elements=[Order.id]))
    return metadata.reference_date


async def initialize(reference: date) -> None:
    try:
        async with async_session_factory.begin() as session:
            actual = await seed_orders(session, reference)
        first, end = previous_month(actual)
        print(
            f"Demo reference date: {actual} UTC. Example goal: Find late shipments over $500 "
            f"from {first} (inclusive) to {end} (exclusive) and draft refund emails."
        )
    finally:
        await engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference-date", type=date.fromisoformat, default=datetime.now(UTC).date())
    asyncio.run(initialize(parser.parse_args().reference_date))
