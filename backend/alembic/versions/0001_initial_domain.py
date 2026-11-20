"""initial_domain

Revision ID: 0001
Revises: (base)
Create Date: 2026-11-20 09:39:25.973162

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0001"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "orders",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("customer_name", sa.String(), nullable=False),
        sa.Column("customer_email", sa.String(), nullable=False),
        sa.Column("amount_minor", sa.BigInteger(), nullable=False),
        sa.Column("currency", sa.String(length=3), server_default="USD", nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("promised_ship_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("shipped_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("currency = 'USD'", name=op.f("ck_orders_currency")),
        sa.CheckConstraint(
            "status IN ('pending', 'shipped', 'cancelled', 'refunded', 'partially_refunded', 'delivered')",
            name=op.f("ck_orders_status"),
        ),
        sa.CheckConstraint("amount_minor >= 0", name=op.f("ck_orders_nonnegative_amount")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_orders")),
    )
    op.create_index("ix_orders_shipped_at_id", "orders", ["shipped_at", "id"], unique=False)
    op.create_table(
        "runs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("goal", sa.String(), nullable=False),
        sa.Column("status", sa.String(), server_default="queued", nullable=False),
        sa.Column("provider", sa.String(), nullable=False),
        sa.Column("model", sa.String(), nullable=False),
        sa.Column("reference_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("business_timezone", sa.String(), nullable=False),
        sa.Column("step_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("tool_call_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("total_tokens", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("estimated_cost_usd", sa.Numeric(precision=20, scale=10), nullable=True),
        sa.Column("active_elapsed_ms", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("duration_ms", sa.BigInteger(), nullable=True),
        sa.Column("max_agent_steps", sa.Integer(), server_default="20", nullable=False),
        sa.Column("max_tool_calls", sa.Integer(), server_default="40", nullable=False),
        sa.Column("model_timeout_seconds", sa.Integer(), server_default="60", nullable=False),
        sa.Column("max_active_run_seconds", sa.Integer(), server_default="300", nullable=False),
        sa.Column(
            "execution_cursor",
            postgresql.JSONB(none_as_null=True, astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("cancellation_requested", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("next_event_sequence", sa.BigInteger(), server_default="1", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint(
            "status IN ('queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelling', 'cancelled')",
            name=op.f("ck_runs_status"),
        ),
        sa.CheckConstraint("char_length(btrim(goal)) BETWEEN 1 AND 2000", name=op.f("ck_runs_goal")),
        sa.CheckConstraint("estimated_cost_usd >= 0 AND duration_ms >= 0", name=op.f("ck_runs_nonnegative_metrics")),
        sa.CheckConstraint(
            "max_agent_steps > 0 AND max_tool_calls > 0 AND model_timeout_seconds > 0 AND max_active_run_seconds > 0",
            name=op.f("ck_runs_positive_limits"),
        ),
        sa.CheckConstraint("next_event_sequence >= 1", name=op.f("ck_runs_positive_next_sequence")),
        sa.CheckConstraint(
            "step_count >= 0 AND tool_call_count >= 0 AND total_tokens >= 0 AND active_elapsed_ms >= 0",
            name=op.f("ck_runs_nonnegative_counters"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_runs")),
    )
    op.create_index("ix_runs_created_at_id", "runs", ["created_at", "id"], unique=False)
    op.create_index("ix_runs_status", "runs", ["status"], unique=False)
    op.create_table(
        "seed_metadata",
        sa.Column("key", sa.String(), nullable=False),
        sa.Column("reference_date", sa.Date(), nullable=False),
        sa.PrimaryKeyConstraint("key", name=op.f("pk_seed_metadata")),
    )
    op.create_table(
        "messages",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("index", sa.Integer(), nullable=False),
        sa.Column("role", sa.String(), nullable=False),
        sa.Column("text", sa.String(), nullable=True),
        sa.Column("provider_payload", postgresql.JSONB(none_as_null=True, astext_type=sa.Text()), nullable=True),
        sa.Column("status", sa.String(), server_default="completed", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("role IN ('system', 'user', 'assistant', 'tool')", name=op.f("ck_messages_role")),
        sa.CheckConstraint('"index" >= 0', name=op.f("ck_messages_nonnegative_index")),
        sa.ForeignKeyConstraint(["run_id"], ["runs.id"], name=op.f("fk_messages_run_id_runs")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_messages")),
        sa.UniqueConstraint("run_id", "id", name=op.f("uq_messages_run_id_id")),
        sa.UniqueConstraint("run_id", "index", name=op.f("uq_messages_run_id_index")),
    )
    op.create_table(
        "model_calls",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("model", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("cached_tokens", sa.Integer(), nullable=True),
        sa.Column("pricing_snapshot", postgresql.JSONB(none_as_null=True, astext_type=sa.Text()), nullable=True),
        sa.Column("estimated_cost_usd", sa.Numeric(precision=20, scale=10), nullable=True),
        sa.Column("usage_complete", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("cached_tokens <= input_tokens", name=op.f("ck_model_calls_cached_subset")),
        sa.CheckConstraint(
            "input_tokens >= 0 AND output_tokens >= 0 AND cached_tokens >= 0 AND estimated_cost_usd >= 0",
            name=op.f("ck_model_calls_nonnegative_usage"),
        ),
        sa.ForeignKeyConstraint(["run_id"], ["runs.id"], name=op.f("fk_model_calls_run_id_runs")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_model_calls")),
    )
    op.create_index("ix_model_calls_run_id", "model_calls", ["run_id"], unique=False)
    op.create_table(
        "run_events",
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("sequence", sa.BigInteger(), autoincrement=False, nullable=False),
        sa.Column("type", sa.String(), nullable=False),
        sa.Column("schema_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column(
            "payload",
            postgresql.JSONB(none_as_null=True, astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.CheckConstraint("jsonb_typeof(payload) = 'object'", name=op.f("ck_run_events_payload_object")),
        sa.CheckConstraint(
            "type IN ('run.queued', 'run.started', 'message.delta', 'message.completed', "
            "'tool.requested', 'tool.started', 'tool.completed', 'tool.failed', 'approval.required', "
            "'approval.decided', 'usage.updated', 'run.completed', 'run.failed', 'run.cancelled')",
            name=op.f("ck_run_events_type"),
        ),
        sa.CheckConstraint("schema_version = 1", name=op.f("ck_run_events_schema_version")),
        sa.CheckConstraint("sequence > 0", name=op.f("ck_run_events_positive_sequence")),
        sa.ForeignKeyConstraint(["run_id"], ["runs.id"], name=op.f("fk_run_events_run_id_runs")),
        sa.PrimaryKeyConstraint("run_id", "sequence", name=op.f("pk_run_events")),
    )
    op.create_table(
        "tool_calls",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("message_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.BigInteger(), sa.Identity(), nullable=False),
        sa.Column("provider_call_id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("arguments", postgresql.JSONB(none_as_null=True, astext_type=sa.Text()), nullable=False),
        sa.Column("status", sa.String(), server_default="requested", nullable=False),
        sa.Column("result", postgresql.JSONB(none_as_null=True, astext_type=sa.Text()), nullable=True),
        sa.Column("error", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("jsonb_typeof(arguments) = 'object'", name=op.f("ck_tool_calls_arguments_object")),
        sa.ForeignKeyConstraint(
            ["run_id", "message_id"],
            ["messages.run_id", "messages.id"],
            name=op.f("fk_tool_calls_run_id_message_id_messages"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_tool_calls")),
        sa.UniqueConstraint("run_id", "id", name=op.f("uq_tool_calls_run_id_id")),
        sa.UniqueConstraint("run_id", "provider_call_id", name=op.f("uq_tool_calls_run_id_provider_call_id")),
    )
    op.create_index("ix_tool_calls_run_id_message_id", "tool_calls", ["run_id", "message_id"], unique=False)
    # A completed provider request is the historical record of what it asked for.
    op.execute("""
        CREATE FUNCTION protect_tool_call_arguments() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'Saved tool-call arguments cannot change' USING ERRCODE = '23514';
        END;
        $$
    """)
    op.execute("""
        CREATE TRIGGER immutable_tool_call_arguments
        BEFORE UPDATE OF arguments ON tool_calls
        FOR EACH ROW WHEN (OLD.arguments IS DISTINCT FROM NEW.arguments)
        EXECUTE FUNCTION protect_tool_call_arguments()
    """)
    op.create_table(
        "approvals",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("tool_call_id", sa.Uuid(), nullable=False),
        sa.Column("proposed_arguments", postgresql.JSONB(none_as_null=True, astext_type=sa.Text()), nullable=False),
        sa.Column("arguments_digest", sa.String(), nullable=False),
        sa.Column("status", sa.String(), server_default="pending", nullable=False),
        sa.Column("reason", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("(status = 'pending') = (decided_at IS NULL)", name=op.f("ck_approvals_decision_time")),
        sa.CheckConstraint("jsonb_typeof(proposed_arguments) = 'object'", name=op.f("ck_approvals_arguments_object")),
        sa.CheckConstraint(
            "status <> 'rejected' OR nullif(btrim(reason), '') IS NOT NULL", name=op.f("ck_approvals_rejection_reason")
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'approved', 'rejected', 'cancelled')", name=op.f("ck_approvals_status")
        ),
        sa.CheckConstraint("length(btrim(arguments_digest)) > 0", name=op.f("ck_approvals_nonblank_digest")),
        sa.ForeignKeyConstraint(
            ["run_id", "tool_call_id"],
            ["tool_calls.run_id", "tool_calls.id"],
            name=op.f("fk_approvals_run_id_tool_call_id_tool_calls"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_approvals")),
        sa.UniqueConstraint("tool_call_id", name=op.f("uq_approvals_tool_call_id")),
    )
    op.create_index("ix_approvals_run_id_status", "approvals", ["run_id", "status"], unique=False)
    op.create_table(
        "refunds",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("order_id", sa.String(), nullable=False),
        sa.Column("tool_call_id", sa.Uuid(), nullable=False),
        sa.Column("policy_version", sa.String(), nullable=False),
        sa.Column("amount_minor", sa.BigInteger(), nullable=False),
        sa.Column("currency", sa.String(length=3), server_default="USD", nullable=False),
        sa.Column("reason", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("currency = 'USD'", name=op.f("ck_refunds_currency")),
        sa.CheckConstraint("amount_minor > 0", name=op.f("ck_refunds_positive_amount")),
        sa.CheckConstraint("length(btrim(policy_version)) > 0", name=op.f("ck_refunds_policy_version")),
        sa.CheckConstraint("length(btrim(reason)) > 0", name=op.f("ck_refunds_reason")),
        sa.ForeignKeyConstraint(["order_id"], ["orders.id"], name=op.f("fk_refunds_order_id_orders")),
        sa.ForeignKeyConstraint(["tool_call_id"], ["tool_calls.id"], name=op.f("fk_refunds_tool_call_id_tool_calls")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_refunds")),
        sa.UniqueConstraint("order_id", "policy_version", name=op.f("uq_refunds_order_id_policy_version")),
        sa.UniqueConstraint("tool_call_id", name=op.f("uq_refunds_tool_call_id")),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table("refunds")
    op.drop_index("ix_approvals_run_id_status", table_name="approvals")
    op.drop_table("approvals")
    op.drop_index("ix_tool_calls_run_id_message_id", table_name="tool_calls")
    op.drop_table("tool_calls")
    op.execute("DROP FUNCTION protect_tool_call_arguments()")
    op.drop_table("run_events")
    op.drop_index("ix_model_calls_run_id", table_name="model_calls")
    op.drop_table("model_calls")
    op.drop_table("messages")
    op.drop_table("seed_metadata")
    op.drop_index("ix_runs_status", table_name="runs")
    op.drop_index("ix_runs_created_at_id", table_name="runs")
    op.drop_table("runs")
    op.drop_index("ix_orders_shipped_at_id", table_name="orders")
    op.drop_table("orders")
