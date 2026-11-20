"""PostgreSQL enforces replay, transcript ownership and ledger keys at write time."""

from datetime import UTC, datetime
from uuid import uuid4

import pytest
from sqlalchemy import insert, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Approval, Message, ModelCall, Order, Refund, Run, RunEventRecord, ToolCall


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
