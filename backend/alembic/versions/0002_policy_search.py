"""policy_search

Revision ID: 0002_policy_search
Revises: 0001
Create Date: 2026-11-25 16:59:15.930246

Stores every policy paragraph with a generated full-text vector (keyword search) and a pgvector embedding
(meaning search), so search_policies can rank by both inside PostgreSQL.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0002_policy_search"
down_revision: str | Sequence[str] | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# A migration describes the schema as it was created, so it keeps its own copy of the vector size.
EMBEDDING_DIMENSIONS = 384


def upgrade() -> None:
    """Upgrade schema."""
    # Needs PostgreSQL with pgvector installed (the pgvector/pgvector image); IF NOT EXISTS makes re-runs harmless.
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.create_table(
        "policy_chunks",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("policy_id", sa.String(), nullable=False),
        sa.Column("version", sa.String(), nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("file", sa.String(), nullable=False),
        sa.Column("chunk_index", sa.Integer(), nullable=False),
        sa.Column("content", sa.String(), nullable=False),
        sa.Column("content_sha256", sa.String(), nullable=False),
        sa.Column("embedding", Vector(EMBEDDING_DIMENSIONS), nullable=False),
        sa.Column("embedding_model", sa.String(), nullable=False),
        sa.Column("indexed_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column(
            "search_vector",
            postgresql.TSVECTOR(),
            sa.Computed(
                "setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', content), 'B')",
                persisted=True,
            ),
            nullable=False,
        ),
        sa.CheckConstraint("chunk_index >= 0", name=op.f("ck_policy_chunks_nonnegative_chunk_index")),
        sa.CheckConstraint("content_sha256 ~ '^[0-9a-f]{64}$'", name=op.f("ck_policy_chunks_content_sha256")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_policy_chunks")),
        sa.UniqueConstraint("policy_id", "chunk_index", name=op.f("uq_policy_chunks_policy_id_chunk_index")),
    )
    op.create_index(
        "ix_policy_chunks_search_vector", "policy_chunks", ["search_vector"], unique=False, postgresql_using="gin"
    )
    # HNSW is pgvector's approximate nearest-neighbour index; m and ef_construction are its documented defaults.
    op.create_index(
        "ix_policy_chunks_embedding",
        "policy_chunks",
        ["embedding"],
        unique=False,
        postgresql_using="hnsw",
        postgresql_with={"m": 16, "ef_construction": 64},
        postgresql_ops={"embedding": "vector_cosine_ops"},
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_policy_chunks_embedding", table_name="policy_chunks")
    op.drop_index("ix_policy_chunks_search_vector", table_name="policy_chunks")
    op.drop_table("policy_chunks")
    # The vector extension stays: it belongs to the whole database and other objects may depend on it.
