"""Relational storage for the run transcript, event history, usage and demo ledger."""

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated
from uuid import UUID, uuid4

from pydantic import JsonValue
from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Identity,
    Index,
    MetaData,
    Numeric,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.runs.schemas import ApprovalStatus, EventType, RunStatus

UUIDKey = Annotated[UUID, mapped_column(primary_key=True, default=uuid4)]
CreatedAt = Annotated[datetime, mapped_column(DateTime(timezone=True), server_default=func.now())]
Timestamp = Annotated[datetime, mapped_column(DateTime(timezone=True))]
Counter = Annotated[int, mapped_column(server_default="0")]
Cost = Annotated[Decimal, mapped_column(Numeric(20, 10))]
JsonObject = Annotated[dict[str, JsonValue], mapped_column(JSONB(none_as_null=True))]
JsonData = Annotated[JsonValue, mapped_column(JSONB(none_as_null=True))]


class Base(DeclarativeBase):
    metadata = MetaData(
        naming_convention={
            "ix": "ix_%(table_name)s_%(column_0_name)s",
            "uq": "uq_%(table_name)s_%(column_0_N_name)s",
            "ck": "ck_%(table_name)s_%(constraint_name)s",
            "fk": "fk_%(table_name)s_%(column_0_N_name)s_%(referred_table_name)s",
            "pk": "pk_%(table_name)s",
        }
    )


def allowed_values(column: str, values: type[RunStatus] | type[ApprovalStatus] | type[EventType]) -> CheckConstraint:
    literals = ", ".join(f"'{item.value}'" for item in values)
    return CheckConstraint(f"{column} IN ({literals})", name=column)


class Run(Base):
    __tablename__ = "runs"
    __table_args__ = (
        allowed_values("status", RunStatus),
        CheckConstraint("char_length(btrim(goal)) BETWEEN 1 AND 2000", name="goal"),
        CheckConstraint(
            "step_count >= 0 AND tool_call_count >= 0 AND total_tokens >= 0 AND active_elapsed_ms >= 0",
            name="nonnegative_counters",
        ),
        CheckConstraint(
            "max_agent_steps > 0 AND max_tool_calls > 0 AND model_timeout_seconds > 0 AND max_active_run_seconds > 0",
            name="positive_limits",
        ),
        CheckConstraint("next_event_sequence >= 1", name="positive_next_sequence"),
        CheckConstraint("estimated_cost_usd >= 0 AND duration_ms >= 0", name="nonnegative_metrics"),
        Index("ix_runs_created_at_id", "created_at", "id"),
        Index("ix_runs_status", "status"),
    )

    id: Mapped[UUIDKey]
    goal: Mapped[str]
    status: Mapped[str] = mapped_column(server_default="queued")
    provider: Mapped[str]
    model: Mapped[str]
    reference_time: Mapped[Timestamp]
    business_timezone: Mapped[str]
    step_count: Mapped[Counter]
    tool_call_count: Mapped[Counter]
    total_tokens: Mapped[int] = mapped_column(BigInteger, server_default="0")
    estimated_cost_usd: Mapped[Cost | None]
    active_elapsed_ms: Mapped[int] = mapped_column(BigInteger, server_default="0")
    duration_ms: Mapped[int | None] = mapped_column(BigInteger)
    max_agent_steps: Mapped[int] = mapped_column(server_default="20")
    max_tool_calls: Mapped[int] = mapped_column(server_default="40")
    model_timeout_seconds: Mapped[int] = mapped_column(server_default="60")
    max_active_run_seconds: Mapped[int] = mapped_column(server_default="300")
    execution_cursor: Mapped[JsonObject] = mapped_column(server_default=text("'{}'::jsonb"))
    cancellation_requested: Mapped[bool] = mapped_column(server_default=text("false"))
    next_event_sequence: Mapped[int] = mapped_column(BigInteger, server_default="1")
    created_at: Mapped[CreatedAt]
    updated_at: Mapped[CreatedAt] = mapped_column(onupdate=func.now())

    @property
    def token_usage_complete(self) -> bool | None:
        complete = self.execution_cursor.get("token_usage_complete")
        return complete if isinstance(complete, bool) else None

    @property
    def cost_is_upper_bound(self) -> bool:
        return self.estimated_cost_usd is not None and self.execution_cursor.get("cost_upper_bound") is True


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (
        UniqueConstraint("run_id", "index"),
        # Composite FK targets ensure that call records cannot cross run boundaries.
        UniqueConstraint("run_id", "id"),
        CheckConstraint('"index" >= 0', name="nonnegative_index"),
        CheckConstraint("role IN ('system', 'user', 'assistant', 'tool')", name="role"),
    )

    id: Mapped[UUIDKey]
    run_id: Mapped[UUID] = mapped_column(ForeignKey("runs.id"))
    index: Mapped[int]
    role: Mapped[str]
    text: Mapped[str | None]
    provider_payload: Mapped[JsonData | None]
    status: Mapped[str] = mapped_column(server_default="completed")
    created_at: Mapped[CreatedAt]


class ToolCall(Base):
    __tablename__ = "tool_calls"
    __table_args__ = (
        ForeignKeyConstraint(["run_id", "message_id"], ["messages.run_id", "messages.id"]),
        UniqueConstraint("run_id", "provider_call_id"),
        UniqueConstraint("run_id", "id"),
        Index("ix_tool_calls_run_id_message_id", "run_id", "message_id"),
        CheckConstraint("jsonb_typeof(arguments) = 'object'", name="arguments_object"),
    )

    id: Mapped[UUIDKey]
    run_id: Mapped[UUID]
    message_id: Mapped[UUID]
    position: Mapped[int] = mapped_column(BigInteger, Identity())
    provider_call_id: Mapped[str]
    name: Mapped[str]
    arguments: Mapped[JsonObject]
    status: Mapped[str] = mapped_column(server_default="requested")
    result: Mapped[JsonData | None]
    error: Mapped[str | None]
    created_at: Mapped[CreatedAt]
    started_at: Mapped[Timestamp | None]
    completed_at: Mapped[Timestamp | None]


class Approval(Base):
    __tablename__ = "approvals"
    __table_args__ = (
        ForeignKeyConstraint(["run_id", "tool_call_id"], ["tool_calls.run_id", "tool_calls.id"]),
        UniqueConstraint("tool_call_id"),
        allowed_values("status", ApprovalStatus),
        CheckConstraint("jsonb_typeof(proposed_arguments) = 'object'", name="arguments_object"),
        CheckConstraint("length(btrim(arguments_digest)) > 0", name="nonblank_digest"),
        CheckConstraint("(status = 'pending') = (decided_at IS NULL)", name="decision_time"),
        CheckConstraint("status <> 'rejected' OR nullif(btrim(reason), '') IS NOT NULL", name="rejection_reason"),
        Index("ix_approvals_run_id_status", "run_id", "status"),
    )

    id: Mapped[UUIDKey]
    run_id: Mapped[UUID]
    tool_call_id: Mapped[UUID]
    proposed_arguments: Mapped[JsonObject]
    arguments_digest: Mapped[str]
    status: Mapped[str] = mapped_column(server_default="pending")
    reason: Mapped[str | None]
    created_at: Mapped[CreatedAt]
    decided_at: Mapped[Timestamp | None]


class RunEventRecord(Base):
    __tablename__ = "run_events"
    __table_args__ = (
        allowed_values("type", EventType),
        CheckConstraint("sequence > 0", name="positive_sequence"),
        CheckConstraint("schema_version = 1", name="schema_version"),
        CheckConstraint("jsonb_typeof(payload) = 'object'", name="payload_object"),
    )

    run_id: Mapped[UUID] = mapped_column(ForeignKey("runs.id"), primary_key=True)
    sequence: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=False)
    type: Mapped[str]
    schema_version: Mapped[int] = mapped_column(server_default="1")
    occurred_at: Mapped[CreatedAt]
    payload: Mapped[JsonObject] = mapped_column(server_default=text("'{}'::jsonb"))


class ModelCall(Base):
    __tablename__ = "model_calls"
    __table_args__ = (
        CheckConstraint(
            "input_tokens >= 0 AND output_tokens >= 0 AND cached_tokens >= 0 AND estimated_cost_usd >= 0",
            name="nonnegative_usage",
        ),
        CheckConstraint("cached_tokens <= input_tokens", name="cached_subset"),
        Index("ix_model_calls_run_id", "run_id"),
    )

    id: Mapped[UUIDKey]
    run_id: Mapped[UUID] = mapped_column(ForeignKey("runs.id"))
    model: Mapped[str]
    status: Mapped[str]
    input_tokens: Mapped[int | None]
    output_tokens: Mapped[int | None]
    cached_tokens: Mapped[int | None]
    pricing_snapshot: Mapped[JsonObject | None]
    estimated_cost_usd: Mapped[Cost | None]
    usage_complete: Mapped[bool] = mapped_column(server_default=text("false"))
    started_at: Mapped[CreatedAt]
    completed_at: Mapped[Timestamp | None]


class Order(Base):
    __tablename__ = "orders"
    __table_args__ = (
        CheckConstraint("amount_minor >= 0", name="nonnegative_amount"),
        CheckConstraint("currency = 'USD'", name="currency"),
        CheckConstraint(
            "status IN ('pending', 'shipped', 'cancelled', 'refunded', 'partially_refunded', 'delivered')",
            name="status",
        ),
        Index("ix_orders_shipped_at_id", "shipped_at", "id"),
    )

    id: Mapped[str] = mapped_column(primary_key=True)
    customer_name: Mapped[str]
    customer_email: Mapped[str]
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    currency: Mapped[str] = mapped_column(String(3), server_default="USD")
    status: Mapped[str]
    promised_ship_at: Mapped[Timestamp]
    shipped_at: Mapped[Timestamp | None]


class Refund(Base):
    __tablename__ = "refunds"
    __table_args__ = (
        UniqueConstraint("tool_call_id"),
        UniqueConstraint("order_id", "policy_version"),
        CheckConstraint("amount_minor > 0", name="positive_amount"),
        CheckConstraint("currency = 'USD'", name="currency"),
        CheckConstraint("length(btrim(policy_version)) > 0", name="policy_version"),
        CheckConstraint("length(btrim(reason)) > 0", name="reason"),
    )

    id: Mapped[UUIDKey]
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"))
    tool_call_id: Mapped[UUID] = mapped_column(ForeignKey("tool_calls.id"))
    policy_version: Mapped[str]
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    currency: Mapped[str] = mapped_column(String(3), server_default="USD")
    reason: Mapped[str]
    created_at: Mapped[CreatedAt]


class SeedMetadata(Base):
    __tablename__ = "seed_metadata"

    key: Mapped[str] = mapped_column(primary_key=True)
    reference_date: Mapped[date]
