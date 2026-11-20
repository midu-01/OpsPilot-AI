"""Read-only late-shipment proposals and the gate on direct refund execution."""

from __future__ import annotations

from typing import Never

from pydantic import BaseModel, ConfigDict, Field, JsonValue
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Order, Refund
from app.tools import ToolSpec

POLICY_VERSION = "v1"
REFUND_CAP_MINOR = 10000


class IssueRefundArgs(BaseModel):
    """The caller identifies the order and explains why it requested an adjustment."""

    model_config = ConfigDict(strict=True, extra="forbid", str_strip_whitespace=True, frozen=True)

    order_id: str = Field(min_length=1, max_length=128, pattern=r"^[^\x00]+$", description="Order ID to review")
    reason: str = Field(min_length=1, max_length=1000, pattern=r"^[^\x00]+$", description="Reason for the refund")


def calculate_refund_amount(order_amount_minor: int, prior_refunds_minor: int) -> int:
    """Round 10% of nonnegative cents half up, cap at $100 and limit to the remaining balance."""
    rounded = (order_amount_minor + 5) // 10
    return max(0, min(rounded, REFUND_CAP_MINOR, order_amount_minor - prior_refunds_minor))


async def preview(args: IssueRefundArgs, *, session: AsyncSession) -> dict[str, JsonValue]:
    """Read persisted order and ledger evidence from a single PostgreSQL statement snapshot."""
    prior_refunds = (
        select(func.coalesce(func.sum(Refund.amount_minor), 0))
        .where(Refund.order_id == Order.id)
        .correlate(Order)
        .scalar_subquery()
    )
    statement = (
        select(
            Order.status,
            Order.customer_name,
            Order.customer_email,
            Order.amount_minor,
            Order.currency,
            Order.shipped_at,
            Order.promised_ship_at,
            prior_refunds.label("prior_refunds_minor"),
            Refund.id.label("existing_refund_id"),
            Refund.amount_minor.label("existing_refund_amount_minor"),
        )
        .select_from(Order)
        .outerjoin(Refund, and_(Refund.order_id == Order.id, Refund.policy_version == POLICY_VERSION))
        .where(Order.id == args.order_id)
        .execution_options(autoflush=False)
    )
    row = (await session.execute(statement)).one_or_none()
    evidence: dict[str, JsonValue] = {
        "order_id": args.order_id,
        "reason": args.reason,
        "policy_version": POLICY_VERSION,
    }

    def deny(message: str, *policies: str, review: bool = False) -> dict[str, JsonValue]:
        return {
            **evidence,
            "eligible": False,
            "error": message,
            "requires_review": review,
            "policy_ids": [*policies, "REVIEW-01"] if review else list(policies),
        }

    if row is None:
        return deny("Order not found", "LATE-01")
    prior = int(row.prior_refunds_minor)
    balance = row.amount_minor - prior
    evidence.update(
        status=row.status,
        customer_name=row.customer_name,
        customer_email=row.customer_email,
        order_amount_minor=row.amount_minor,
        currency=row.currency,
        shipped_at=row.shipped_at.isoformat() if row.shipped_at else None,
        promised_ship_at=row.promised_ship_at.isoformat(),
        prior_refunds_minor=prior,
        remaining_balance_minor=balance,
    )

    if row.existing_refund_id is not None:
        evidence.update(
            existing_refund_id=str(row.existing_refund_id),
            existing_refund_amount_minor=row.existing_refund_amount_minor,
        )
        return deny("Refund already issued under this policy version", "DUP-01")
    if row.currency != "USD":
        return deny("Unsupported refund currency", review=True)
    if balance < 0:
        return deny("Refund ledger exceeds the order total", "PARTIAL-01", review=True)
    if row.status == "refunded":
        return deny("Order is marked fully refunded", "EXCLUDE-01", review=balance != 0)
    if row.status == "partially_refunded" and (prior == 0 or balance == 0):
        return deny("Partial refund status conflicts with the ledger balance", "PARTIAL-01", review=True)
    if row.status in {"pending", "cancelled"}:
        if row.shipped_at is not None:
            return deny("Shipment timestamp conflicts with order status", "EXCLUDE-01", review=True)
        return deny(f"Order is {'unshipped' if row.status == 'pending' else 'cancelled'}", "EXCLUDE-01")
    if row.shipped_at is None:
        return deny("Missing shipment timestamp", "SHIP-01", "EXCLUDE-01", review=True)
    if row.shipped_at <= row.promised_ship_at:
        return deny("Order shipped on time", "SHIP-01", "LATE-01")
    amount = calculate_refund_amount(row.amount_minor, prior)
    if amount == 0:
        return deny("No refundable amount remains under the policy", "AMOUNT-01", "PARTIAL-01")
    return {
        **evidence,
        "eligible": True,
        "requires_approval": True,
        "refund_amount_minor": amount,
        "policy_ids": ["SHIP-01", "LATE-01", "EXCLUDE-01", "AMOUNT-01", "PARTIAL-01", "DUP-01", "REVIEW-01"],
    }


async def execute(args: IssueRefundArgs, *, session: AsyncSession) -> Never:
    """Only the approval service may execute the exact persisted proposal."""
    raise PermissionError("Human approval is required to issue a refund")


spec = ToolSpec(
    name="issue_refund",
    description="Request a policy-backed late-shipment refund. Issuing the refund requires human approval.",
    parameters_model=IssueRefundArgs,
    executor=lambda args, ctx: execute(args, session=ctx.session),
    requires_approval=True,
    is_read_only=False,
)
