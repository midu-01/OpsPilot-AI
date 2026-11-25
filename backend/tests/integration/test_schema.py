"""PostgreSQL enforces replay, transcript ownership, ledger keys, accounts and the policy index at write time."""

import hashlib
import os
import sys
from asyncio import create_subprocess_exec, subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models import (
    Approval,
    Message,
    ModelCall,
    Order,
    PolicyChunk,
    Refund,
    Run,
    RunEventRecord,
    ToolCall,
    User,
    UserSession,
)
from app.search.embeddings import EMBEDDING_DIMENSIONS


async def create_run(session: AsyncSession) -> Run:
    run = Run(
        goal="Review this order",
        model="script",
        provider="fake",
        reference_time=datetime.now(UTC),
        business_timezone="UTC",
    )
    session.add(run)
    await session.flush()
    return run


async def create_message(session: AsyncSession, run: Run) -> Message:
    message = Message(run_id=run.id, index=0, role="assistant")
    session.add(message)
    await session.flush()
    return message


async def create_call(session: AsyncSession, message: Message) -> ToolCall:
    call = ToolCall(
        run_id=message.run_id,
        message_id=message.id,
        name="issue_refund",
        provider_call_id=str(uuid4()),
        arguments={"amount_minor": 3500},
    )
    session.add(call)
    await session.flush()
    return call


async def test_unique_event_sequences_and_message_indices(db_session: AsyncSession) -> None:
    run = await create_run(db_session)
    other = await create_run(db_session)
    for owner in (run, other):
        await create_message(db_session, owner)
        await db_session.execute(insert(RunEventRecord).values(run_id=owner.id, sequence=1, type="run.queued"))

    with pytest.raises(IntegrityError, match="pk_run_events"):
        async with db_session.begin_nested():
            await db_session.execute(insert(RunEventRecord).values(run_id=run.id, sequence=1, type="run.started"))
    with pytest.raises(IntegrityError, match="uq_messages_run_id_index"):
        async with db_session.begin_nested():
            await create_message(db_session, run)
    with pytest.raises(IntegrityError, match="ck_run_events_positive_sequence"):
        async with db_session.begin_nested():
            await db_session.execute(insert(RunEventRecord).values(run_id=run.id, sequence=0, type="run.queued"))


async def test_approval_and_tool_call_belong_to_the_same_run(db_session: AsyncSession) -> None:
    run = await create_run(db_session)
    other = await create_run(db_session)
    message = await create_message(db_session, run)
    call = await create_call(db_session, message)

    with pytest.raises(IntegrityError, match="fk_tool_calls_run_id_message_id_messages"):
        async with db_session.begin_nested():
            await db_session.execute(
                insert(ToolCall).values(
                    run_id=other.id, message_id=message.id, provider_call_id="mismatch", name="test", arguments={}
                )
            )

    proposal = insert(Approval).values(tool_call_id=call.id, proposed_arguments=call.arguments, arguments_digest="d")
    with pytest.raises(IntegrityError, match="fk_approvals_run_id_tool_call_id_tool_calls"):
        async with db_session.begin_nested():
            await db_session.execute(proposal.values(run_id=other.id))
    await db_session.execute(proposal.values(run_id=run.id))
    with pytest.raises(IntegrityError, match="uq_approvals_tool_call_id"):
        async with db_session.begin_nested():
            await db_session.execute(proposal.values(run_id=run.id))
    with pytest.raises(IntegrityError, match="ck_approvals_rejection_reason"):
        async with db_session.begin_nested():
            await db_session.execute(
                update(Approval)
                .where(Approval.tool_call_id == call.id)
                .values(status="rejected", decided_at=datetime.now(UTC), reason=" ")
            )


async def test_tool_call_arguments_are_immutable_after_insert(db_session: AsyncSession) -> None:
    message = await create_message(db_session, await create_run(db_session))
    call = await create_call(db_session, message)
    with pytest.raises(IntegrityError, match="Saved tool-call arguments cannot change"):
        async with db_session.begin_nested():
            await db_session.execute(
                update(ToolCall).where(ToolCall.id == call.id).values(arguments={"amount_minor": 1})
            )
    await db_session.execute(update(ToolCall).where(ToolCall.id == call.id).values(status="completed", result="done"))
    await db_session.refresh(call)
    assert call.result == "done"
    assert call.arguments == {"amount_minor": 3500}


async def test_refund_prevents_replay_and_equivalent_requests(db_session: AsyncSession) -> None:
    message = await create_message(db_session, await create_run(db_session))
    call = await create_call(db_session, message)
    equivalent = await create_call(db_session, message)
    assert equivalent.position > call.position
    order = Order(
        id=f"ORD-{uuid4().hex}",
        customer_name="Test",
        customer_email="demo@example.test",
        amount_minor=75000,
        status="shipped",
        promised_ship_at=datetime.now(UTC),
        shipped_at=datetime.now(UTC),
    )
    db_session.add(order)
    await db_session.flush()
    refund = insert(Refund).values(order_id=order.id, amount_minor=3500, reason="Late shipment")
    await db_session.execute(refund.values(tool_call_id=call.id, policy_version="v1"))
    with pytest.raises(IntegrityError, match="uq_refunds_tool_call_id"):
        async with db_session.begin_nested():
            await db_session.execute(refund.values(tool_call_id=call.id, policy_version="v2"))
    with pytest.raises(IntegrityError, match="uq_refunds_order_id_policy_version"):
        async with db_session.begin_nested():
            await db_session.execute(refund.values(tool_call_id=equivalent.id, policy_version="v1"))

    with pytest.raises(IntegrityError, match="ck_refunds_positive_amount"):
        async with db_session.begin_nested():
            await db_session.execute(refund.values(tool_call_id=equivalent.id, policy_version="v2", amount_minor=0))


async def test_model_usage_preserves_unreported_counts_and_rejects_negative_values(db_session: AsyncSession) -> None:
    run = await create_run(db_session)
    attempt = ModelCall(run_id=run.id, model="script", status="started")
    db_session.add(attempt)
    await db_session.flush()
    assert attempt.input_tokens is None and attempt.output_tokens is None
    assert attempt.usage_complete is False
    with pytest.raises(IntegrityError, match="ck_model_calls_nonnegative_usage"):
        async with db_session.begin_nested():
            await db_session.execute(update(ModelCall).where(ModelCall.id == attempt.id).values(output_tokens=-1))


async def test_users_keep_one_canonical_email(db_session: AsyncSession) -> None:
    account = {"display_name": "Alex Rivera", "password_hash": "hash"}
    await db_session.execute(insert(User).values(email="alex@opspilot.test", **account))
    for values, constraint in [
        ({"email": "Alex@opspilot.test"}, "ck_users_normalized_email"),
        ({"email": " sam@opspilot.test"}, "ck_users_normalized_email"),
        ({"email": "sam.opspilot.test"}, "ck_users_normalized_email"),
        ({"email": "alex@opspilot.test"}, "uq_users_email"),
        ({"email": "sam@opspilot.test", "display_name": " "}, "ck_users_nonblank_display_name"),
    ]:
        with pytest.raises(IntegrityError, match=constraint):
            async with db_session.begin_nested():
                await db_session.execute(insert(User).values({**account, **values}))


async def test_sessions_store_only_unique_token_digests_and_runs_need_a_real_owner(db_session: AsyncSession) -> None:
    user_id = await db_session.scalar(
        insert(User).values(email="sam@opspilot.test", display_name="Sam Chen", password_hash="hash").returning(User.id)
    )
    sign_in = insert(UserSession).values(user_id=user_id, expires_at=datetime.now(UTC) + timedelta(hours=12))
    digest = hashlib.sha256(b"opaque-token").hexdigest()
    await db_session.execute(sign_in.values(token_hash=digest))
    for token_hash, constraint in [
        (digest, "uq_user_sessions_token_hash"),
        ("raw-token", "ck_user_sessions_token_hash"),
    ]:
        with pytest.raises(IntegrityError, match=constraint):
            async with db_session.begin_nested():
                await db_session.execute(sign_in.values(token_hash=token_hash))

    run = await create_run(db_session)
    assert run.user_id is None  # Runs created before accounts existed have no owner.
    with pytest.raises(IntegrityError, match="fk_runs_user_id_users"):
        async with db_session.begin_nested():
            await db_session.execute(update(Run).where(Run.id == run.id).values(user_id=uuid4()))


def unit_vector(position: int) -> list[float]:
    vector = [0.0] * EMBEDDING_DIMENSIONS
    vector[position] = 1.0
    return vector


def chunk(**overrides: Any) -> dict[str, Any]:
    content = overrides.pop("content", "Apply a cap of USD 100 to the late shipment refund.")
    return {
        "policy_id": "AMOUNT-01",
        "version": "v1",
        "title": "Late shipment refund amount",
        "file": "03-refund-amount.md",
        "chunk_index": 0,
        "content": content,
        "content_sha256": hashlib.sha256(content.encode()).hexdigest(),
        "embedding": unit_vector(0),
        "embedding_model": "hashing-v1",
    } | overrides


async def test_policy_chunks_hold_one_row_per_paragraph_with_a_fixed_vector_size(db_session: AsyncSession) -> None:
    await db_session.execute(delete(PolicyChunk))  # Start empty: the sessions fixture indexes the bundled policies.
    await db_session.execute(insert(PolicyChunk).values(chunk()))
    for overrides, constraint in [
        ({}, "uq_policy_chunks_policy_id_chunk_index"),
        ({"chunk_index": -1}, "ck_policy_chunks_nonnegative_chunk_index"),
        ({"chunk_index": 1, "content_sha256": "not-a-digest"}, "ck_policy_chunks_content_sha256"),
    ]:
        with pytest.raises(IntegrityError, match=constraint):
            async with db_session.begin_nested():
                await db_session.execute(insert(PolicyChunk).values(chunk(**overrides)))
    with pytest.raises(DBAPIError, match=f"expected {EMBEDDING_DIMENSIONS} dimensions, not 3"):
        async with db_session.begin_nested():
            await db_session.execute(insert(PolicyChunk).values(chunk(chunk_index=1, embedding=[1.0, 0.0, 0.0])))


async def test_policy_chunks_derive_weighted_keywords_and_compare_embeddings(db_session: AsyncSession) -> None:
    escalation = chunk(
        policy_id="REVIEW-01",
        title="Escalation and human approval",
        content="Escalate an inconsistent refund history.",
        embedding=unit_vector(1),
    )
    await db_session.execute(delete(PolicyChunk))  # Start empty: the sessions fixture indexes the bundled policies.
    await db_session.execute(insert(PolicyChunk).values([chunk(), escalation]))

    # The generated search_vector weights title words A and paragraph words B.
    def matching(tsquery: str) -> Any:
        query = func.to_tsquery("english", tsquery)
        return select(PolicyChunk.policy_id).where(PolicyChunk.search_vector.bool_op("@@")(query))

    assert set(await db_session.scalars(matching("refund"))) == {"AMOUNT-01", "REVIEW-01"}
    assert list(await db_session.scalars(matching("refund:A"))) == ["AMOUNT-01"]

    # pgvector binds a plain list[float] through asyncpg and returns one; <=> is the cosine distance.
    distance = PolicyChunk.embedding.cosine_distance(unit_vector(0))
    ranked = (await db_session.execute(select(PolicyChunk.policy_id, 1 - distance).order_by(distance))).all()
    assert [(policy_id, round(similarity, 6)) for policy_id, similarity in ranked] == [
        ("AMOUNT-01", 1.0),
        ("REVIEW-01", 0.0),
    ]
    stored = await db_session.scalar(select(PolicyChunk.embedding).where(PolicyChunk.policy_id == "REVIEW-01"))
    assert stored == unit_vector(1)


async def test_migrations_and_models_describe_the_same_schema(sessions: async_sessionmaker[AsyncSession]) -> None:
    """`alembic check` compares the migrated database with app.models; a model change without a migration fails."""
    url = sessions.kw["bind"].url.render_as_string(hide_password=False)
    check = await create_subprocess_exec(
        sys.executable,
        "-m",
        "alembic",
        "check",
        cwd=Path(__file__).resolve().parents[2],
        env={**os.environ, "DATABASE_URL": url},
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    output, _ = await check.communicate()
    assert check.returncode == 0, output.decode()
