"""users_and_run_owners

Revision ID: 0003_users_and_run_owners
Revises: 0002_policy_search
Create Date: 2026-11-25 16:59:15.930246

Adds accounts, sessions that store only a hash of their token, and an owner on every run.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0003_users_and_run_owners"
down_revision: str | Sequence[str] | None = "0002_policy_search"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("email", sa.String(), nullable=False),
        sa.Column("display_name", sa.String(), nullable=False),
        sa.Column("password_hash", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint(
            "email = lower(btrim(email)) AND strpos(email, '@') > 0", name=op.f("ck_users_normalized_email")
        ),
        sa.CheckConstraint("length(btrim(display_name)) > 0", name=op.f("ck_users_nonblank_display_name")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_users")),
        sa.UniqueConstraint("email", name=op.f("uq_users_email")),
    )
    op.create_table(
        "user_sessions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("token_hash ~ '^[0-9a-f]{64}$'", name=op.f("ck_user_sessions_token_hash")),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_user_sessions_user_id_users")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_user_sessions")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_user_sessions_token_hash")),
    )
    op.create_index("ix_user_sessions_user_id", "user_sessions", ["user_id"], unique=False)
    # Nullable: runs created before accounts existed have no owner until the seed assigns them one.
    op.add_column("runs", sa.Column("user_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(op.f("fk_runs_user_id_users"), "runs", "users", ["user_id"], ["id"])
    op.create_index("ix_runs_user_id_created_at_id", "runs", ["user_id", "created_at", "id"], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_runs_user_id_created_at_id", table_name="runs")
    op.drop_constraint(op.f("fk_runs_user_id_users"), "runs", type_="foreignkey")
    op.drop_column("runs", "user_id")
    op.drop_index("ix_user_sessions_user_id", table_name="user_sessions")
    op.drop_table("user_sessions")
    op.drop_table("users")
