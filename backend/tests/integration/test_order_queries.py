"""Exercise the model's typed order filters against managed PostgreSQL fixtures."""

from datetime import UTC, date, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Order
from app.seed import seed_orders
from app.tools.date_math import DateMathArgs
from app.tools.date_math import execute as calculate
from app.tools.query_orders import QueryOrdersArgs
from app.tools.query_orders import execute as query_orders


async def test_seeded_orders_use_strict_amount_and_late_shipment_filters(db_session: AsyncSession) -> None:
    async with db_session.begin():
        await seed_orders(db_session, date(2028, 3, 10))
    args = QueryOrdersArgs.model_validate(
        {
            "min_amount_minor": 50000,
            "late_only": True,
            "shipped_after": "2028-02-01T00:00:00+00:00",
            "shipped_before": "2028-03-01T00:00:00+00:00",
        }
    )
    result = await query_orders(args, session=db_session)
    assert [order["id"] for order in result["orders"]] == [
        "ORD-1001",
        "ORD-1006",
        "ORD-1007",
        "ORD-1012",
        "ORD-1013",
        "ORD-1018",
        "ORD-1019",
        "ORD-1024",
        "ORD-1025",
        "ORD-1030",
    ]
    assert result["count"] == 10

    exact = await query_orders(QueryOrdersArgs(min_amount_minor=49999, max_amount_minor=50000), session=db_session)
    assert exact["orders"] and all(row["amount_minor"] == 50000 for row in exact["orders"])
    pending = await query_orders(QueryOrdersArgs(status="pending"), session=db_session)
    assert [row["shipped_at"] for row in pending["orders"]] == [None]


async def test_month_bounds_compose_and_equal_sort_keys_paginate(db_session: AsyncSession) -> None:
    month = await calculate(
        DateMathArgs(operation="previous_month"),
        reference_time=datetime(2024, 5, 1, 0, tzinfo=UTC),
        timezone="America/New_York",  # The local run date is still April 30.
    )
    filters = {"shipped_after": month["shipped_after"], "shipped_before": month["shipped_before"]}
    start = datetime(2024, 3, 1, 5, tzinfo=UTC)
    end = datetime(2024, 4, 1, 4, tzinfo=UTC)
    instant = timedelta(microseconds=1)
    records = {"outside-end": end, "b": end - instant, "outside-start": start - instant, "a": start, "c": start}
    async with db_session.begin():
        for order_id, shipped in records.items():
            db_session.add(
                Order(
                    id=order_id,
                    customer_name="A",
                    customer_email="a@example.test",
                    amount_minor=75000,
                    status="shipped",
                    promised_ship_at=shipped - instant,
                    shipped_at=shipped,
                )
            )

    for field, direction, expected in [
        ("amount_minor", "desc", ["a", "b", "c"]),
        ("shipped_at", "asc", ["a", "c", "b"]),
        ("id", "desc", ["c", "b", "a"]),
    ]:
        page_ids: list[str] = []
        for offset in (0, 2, 4):
            args = QueryOrdersArgs.model_validate(
                {**filters, "sort_by": field, "sort_order": direction, "limit": 2, "offset": offset}
            )
            page = await query_orders(args, session=db_session)
            assert page["count"] == len(page["orders"]) <= 2
            assert (page["offset"], page["limit"]) == (offset, 2)
            page_ids.extend(row["id"] for row in page["orders"])
        assert page_ids == expected


async def test_query_reads_stored_values_without_flushing_session(db_session: AsyncSession) -> None:
    async with db_session.begin():
        await seed_orders(db_session, date(2028, 3, 10))

    order = await db_session.get_one(Order, "ORD-1001")
    order.amount_minor = 1
    page = await query_orders(QueryOrdersArgs(min_amount_minor=50000, limit=1), session=db_session)
    assert page["orders"][0]["id"] == order.id
    assert page["orders"][0]["amount_minor"] == 62500
    assert order in db_session.dirty
    assert order.amount_minor == 1
