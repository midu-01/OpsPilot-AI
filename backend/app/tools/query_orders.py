"""Read-only order queries with typed filters."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Self, TypedDict

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Order
from app.tools import ToolSpec

MAX_BIGINT = 2**63 - 1
OrderStatus = Literal["pending", "shipped", "cancelled", "refunded", "partially_refunded", "delivered"]


class QueryOrdersArgs(BaseModel):
    """Typed filters for the orders table."""

    model_config = ConfigDict(extra="forbid", strict=True)

    min_amount_minor: int | None = Field(None, ge=0, le=MAX_BIGINT, description="Minimum amount in cents (exclusive)")
    max_amount_minor: int | None = Field(None, ge=0, le=MAX_BIGINT, description="Maximum amount in cents (inclusive)")
    shipped_after: AwareDatetime | None = Field(None, description="Inclusive shipment timestamp with UTC offset")
    shipped_before: AwareDatetime | None = Field(None, description="Exclusive shipment timestamp with UTC offset")
    late_only: bool = Field(False, description="Only orders where shipped_at > promised_ship_at")
    status: OrderStatus | None = None
    limit: int = Field(20, ge=1, le=100, description="Maximum results to return")
    offset: int = Field(0, ge=0, le=MAX_BIGINT, description="Pagination offset")
    sort_by: Literal["amount_minor", "shipped_at", "id"] = "id"
    sort_order: Literal["asc", "desc"] = "asc"

    @field_validator("shipped_after", "shipped_before", mode="before")
    @classmethod
    def parse_iso_timestamp(cls, value: object) -> object:
        return datetime.fromisoformat(value) if isinstance(value, str) else value

    @model_validator(mode="after")
    def validate_ranges(self) -> Self:
        if (
            self.shipped_after is not None
            and self.shipped_before is not None
            and self.shipped_after >= self.shipped_before
        ):
            raise ValueError("shipped_before must be later than shipped_after")
        if (
            self.min_amount_minor is not None
            and self.max_amount_minor is not None
            and self.min_amount_minor >= self.max_amount_minor
        ):
            raise ValueError("max_amount_minor must exceed the exclusive min_amount_minor")
        return self


class OrderRow(TypedDict):
    id: str
    customer_name: str
    customer_email: str
    amount_minor: int
    currency: str
    status: str
    promised_ship_at: str
    shipped_at: str | None


class QueryResult(TypedDict):
    orders: list[OrderRow]
    count: int
    offset: int
    limit: int


async def execute(args: QueryOrdersArgs, *, session: AsyncSession) -> QueryResult:
    """Return a bounded page. Orders tied on the requested key sort by ascending ID."""
    query = select(
        Order.id,
        Order.customer_name,
        Order.customer_email,
        Order.amount_minor,
        Order.currency,
        Order.status,
        Order.promised_ship_at,
        Order.shipped_at,
    ).execution_options(autoflush=False)
    if args.min_amount_minor is not None:
        query = query.where(Order.amount_minor > args.min_amount_minor)
    if args.max_amount_minor is not None:
        query = query.where(Order.amount_minor <= args.max_amount_minor)
    if args.shipped_after is not None:
        query = query.where(Order.shipped_at >= args.shipped_after)
    if args.shipped_before is not None:
        query = query.where(Order.shipped_at < args.shipped_before)
    if args.late_only:
        query = query.where(Order.shipped_at > Order.promised_ship_at)
    if args.status is not None:
        query = query.where(Order.status == args.status)

    sort_col = {"amount_minor": Order.amount_minor, "shipped_at": Order.shipped_at, "id": Order.id}[args.sort_by]
    sort = sort_col.desc() if args.sort_order == "desc" else sort_col.asc()
    query = query.order_by(sort.nulls_last())
    if args.sort_by != "id":
        query = query.order_by(Order.id)
    rows = (await session.execute(query.offset(args.offset).limit(args.limit))).all()
    return {
        "orders": [
            {
                "id": order.id,
                "customer_name": order.customer_name,
                "customer_email": order.customer_email,
                "amount_minor": order.amount_minor,
                "currency": order.currency,
                "status": order.status,
                "promised_ship_at": order.promised_ship_at.isoformat(),
                "shipped_at": order.shipped_at.isoformat() if order.shipped_at else None,
            }
            for order in rows
        ],
        "count": len(rows),
        "offset": args.offset,
        "limit": args.limit,
    }


spec = ToolSpec(
    name="query_orders",
    description="Query orders by amount in cents, shipment timestamps, lateness, or status. Returns one sorted page.",
    parameters_model=QueryOrdersArgs,
    executor=lambda args, ctx: execute(args, session=ctx.session),
    is_read_only=True,
)
