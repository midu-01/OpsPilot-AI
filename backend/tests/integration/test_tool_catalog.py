"""Exercise provider-facing calls against the same catalog used by the backend."""

from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Refund
from app.runs.schemas import ToolFailure, ToolSuccess
from app.search.embeddings import HashingEmbedder
from app.seed import seed_orders
from app.tools import ToolContext
from app.tools.registry import get_registry


async def test_catalog_can_investigate_a_refund_but_cannot_issue_it(db_session: AsyncSession) -> None:
    clock = datetime(2026, 11, 19, tzinfo=UTC)
    async with db_session.begin():
        await seed_orders(db_session, clock.date())
    context = ToolContext(db_session, clock, "UTC", HashingEmbedder())
    dispatch = get_registry().dispatch
    month = await dispatch("date_math", {"operation": "previous_month"}, context)
    assert isinstance(month, ToolSuccess) and isinstance(month.data, dict)
    orders = await dispatch(
        "query_orders",
        {
            "shipped_after": month.data["shipped_after"],
            "shipped_before": month.data["shipped_before"],
            "min_amount_minor": 50000,
            "late_only": True,
        },
        context,
    )
    assert isinstance(orders, ToolSuccess) and orders.data["orders"][0]["id"] == "ORD-1001"
    evidence = await dispatch("search_policies", {"query": "AMOUNT-01"}, context)
    assert isinstance(evidence, ToolSuccess) and evidence.data["matches"][0]["version"] == "v1"
    request = {"order_id": "ORD-1001", "reason": "Late shipment"}
    for arguments, expected in [(request, "APPROVAL_REQUIRED"), ({**request, "approved": True}, "INVALID_ARGUMENTS")]:
        denied = await dispatch("issue_refund", arguments, context)
        assert isinstance(denied, ToolFailure) and denied.error.code == expected
    assert await db_session.scalar(select(func.count()).select_from(Refund)) == 0

    overflow = await dispatch(
        "date_math", {"operation": "add_days", "reference_date": "9999-12-31", "days": 1}, context
    )
    assert isinstance(overflow, ToolFailure) and overflow.error.code == "INVALID_ARGUMENTS"
