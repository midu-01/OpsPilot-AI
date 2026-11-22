"""Integration assertions connecting seeded orders, policy documents, approval decisions, and ledger effects."""

from datetime import date
from uuid import UUID

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent.loop import execute_run
from app.agent.scenario_provider import ScenarioProvider
from app.db import get_session, get_session_factory
from app.main import app
from app.models import Order, Refund, Run, ToolCall
from app.runs.schemas import ApprovalStatus, RunStatus
from app.runs.service import get_snapshot
from app.seed import seed_orders

type Sessions = async_sessionmaker[AsyncSession]
FIXED_SEED_DATE = date(2026, 2, 15)


@pytest.fixture
async def client(sessions: Sessions) -> AsyncClient:
    async def isolated_session():
        async with sessions() as session:
            yield session

    app.dependency_overrides[get_session] = isolated_session
    app.dependency_overrides[get_session_factory] = lambda: sessions
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
            yield http
    finally:
        app.dependency_overrides.pop(get_session, None)
        app.dependency_overrides.pop(get_session_factory, None)


async def refund_rows_for_run(session: AsyncSession, run_id: UUID) -> list[Refund]:
    query = (
        select(Refund)
        .join(ToolCall, ToolCall.id == Refund.tool_call_id)
        .where(ToolCall.run_id == run_id)
    )
    return list(await session.scalars(query))


async def test_draft_only_scenario_creates_no_refunds_and_preserves_ledger(
    sessions: Sessions, client: AsyncClient
) -> None:
    """The draft goal must analyze orders and draft emails without writing to the refund ledger."""
    async with sessions.begin() as session:
        await seed_orders(session, FIXED_SEED_DATE)
        initial_order_count = await session.scalar(select(func.count(Order.id)))
        initial_refund_count = await session.scalar(select(func.count(Refund.id)))

    resp = await client.post(
        "/runs",
        json={"goal": "Find orders over $500 that shipped late last month and draft a refund email for each."},
    )
    assert resp.status_code == 202
    run_id = UUID(resp.json()["id"])

    # Execute with the deterministic scenario provider
    provider = ScenarioProvider()
    async with sessions.begin() as session:
        run = await session.get_one(Run, run_id)
        run.status = "running"
    await execute_run(sessions, run_id, provider)

    # Verify run completed
    async with sessions() as session:
        snapshot = await get_snapshot(session, run_id)
        assert snapshot is not None
        assert snapshot.status == RunStatus.completed
        assert snapshot.pending_approval is None
        assert len(snapshot.approvals) == 0

        # Verify no issue_refund tool call was requested
        called_tool_names = [call.name for m in snapshot.messages for call in m.tool_calls]
        assert "issue_refund" not in called_tool_names
        assert "date_math" in called_tool_names
        assert "query_orders" in called_tool_names
        assert "search_policies" in called_tool_names

        # Final assistant text contains draft
        assistant_msgs = [m.text for m in snapshot.messages if m.role == "assistant" and m.text]
        assert any("Found" in text and "EMAIL-01" in text for text in assistant_msgs)

        # Authoritative database proof: ledger is completely unchanged
        final_order_count = await session.scalar(select(func.count(Order.id)))
        final_refund_count = await session.scalar(select(func.count(Refund.id)))
        run_refunds = await refund_rows_for_run(session, run_id)

        assert final_order_count == initial_order_count
        assert final_refund_count == initial_refund_count
        assert len(run_refunds) == 0


async def test_explicit_approval_scenario_commits_exact_refund_and_is_idempotent(
    sessions: Sessions, client: AsyncClient
) -> None:
    """Approval proposal pauses for human review and writes to the simulated ledger only upon approval."""
    async with sessions.begin() as session:
        await seed_orders(session, FIXED_SEED_DATE)

    resp = await client.post(
        "/runs",
        json={"goal": "Find order ORD-1001 that shipped late and propose a simulated refund under policy."},
    )
    assert resp.status_code == 202
    run_id = UUID(resp.json()["id"])

    # Execute until paused at approval
    provider = ScenarioProvider()
    async with sessions.begin() as session:
        run = await session.get_one(Run, run_id)
        run.status = "running"
    await execute_run(sessions, run_id, provider)

    # Assert paused at awaiting_approval
    async with sessions() as session:
        snapshot = await get_snapshot(session, run_id)
        assert snapshot is not None
        assert snapshot.status == RunStatus.awaiting_approval
        assert snapshot.pending_approval is not None

        pending = snapshot.pending_approval
        assert pending.tool_name == "issue_refund"
        assert pending.proposed_arguments["order_id"] == "ORD-1001"
        assert pending.proposed_arguments["amount_minor"] == 6250
        approval_id = pending.id

        # Before approval decision: zero refunds in ledger for this run
        run_refunds_before = await refund_rows_for_run(session, run_id)
        assert len(run_refunds_before) == 0

    # Submit approval through POST /runs/{id}/approve
    decision_payload = {"approval_id": str(approval_id), "decision": "approve"}
    approve_resp = await client.post(f"/runs/{run_id}/approve", json=decision_payload)
    assert approve_resp.status_code == 200

    # Idempotent repeated identical decision returns stored result
    repeat_resp = await client.post(f"/runs/{run_id}/approve", json=decision_payload)
    assert repeat_resp.status_code == 200

    # Resume execution with fresh provider instance (simulating worker claim after requeue)
    new_provider = ScenarioProvider()
    async with sessions.begin() as session:
        run = await session.get_one(Run, run_id)
        run.status = "running"
    await execute_run(sessions, run_id, new_provider)

    # Verify final terminal state and ledger row
    async with sessions() as session:
        snapshot = await get_snapshot(session, run_id)
        assert snapshot is not None
        assert snapshot.status == RunStatus.completed
        assert snapshot.pending_approval is None

        # Authoritative verification against PostgreSQL refunds table
        run_refunds = await refund_rows_for_run(session, run_id)
        assert len(run_refunds) == 1
        record = run_refunds[0]
        assert record.order_id == "ORD-1001"
        assert record.amount_minor == 6250
        assert record.currency == "USD"
        assert "v1" in record.policy_version

        # Conflicting/stale decision returns 409
        conflict_resp = await client.post(
            f"/runs/{run_id}/approve",
            json={"approval_id": str(approval_id), "decision": "reject", "reason": "Change my mind"},
        )
        assert conflict_resp.status_code == 409


async def test_rejection_scenario_records_reason_and_leaves_ledger_clean(
    sessions: Sessions, client: AsyncClient
) -> None:
    """Rejection records operator reason and resumes agent without any write to the ledger."""
    async with sessions.begin() as session:
        await seed_orders(session, FIXED_SEED_DATE)

    resp = await client.post(
        "/runs",
        json={"goal": "Propose a refund for ORD-1006 under policy."},
    )
    assert resp.status_code == 202
    run_id = UUID(resp.json()["id"])

    # Run until paused
    provider = ScenarioProvider()
    async with sessions.begin() as session:
        run = await session.get_one(Run, run_id)
        run.status = "running"
    await execute_run(sessions, run_id, provider)

    async with sessions() as session:
        snapshot = await get_snapshot(session, run_id)
        assert snapshot is not None
        assert snapshot.status == RunStatus.awaiting_approval
        assert snapshot.pending_approval is not None
        approval_id = snapshot.pending_approval.id

    # Blank reason rejected with 422
    blank_resp = await client.post(
        f"/runs/{run_id}/approve",
        json={"approval_id": str(approval_id), "decision": "reject", "reason": "   "},
    )
    assert blank_resp.status_code == 422

    # Valid rejection with reason
    rejection_reason = "Customer requested store credit instead."
    reject_resp = await client.post(
        f"/runs/{run_id}/approve",
        json={"approval_id": str(approval_id), "decision": "reject", "reason": rejection_reason},
    )
    assert reject_resp.status_code == 200

    # Resume run after rejection
    new_provider = ScenarioProvider()
    async with sessions.begin() as session:
        run = await session.get_one(Run, run_id)
        run.status = "running"
    await execute_run(sessions, run_id, new_provider)

    # Verify run completed and zero refunds committed
    async with sessions() as session:
        snapshot = await get_snapshot(session, run_id)
        assert snapshot is not None
        assert snapshot.status == RunStatus.completed
        assert snapshot.pending_approval is None

        # Verify rejection recorded in approvals
        decided_approval = next(a for a in snapshot.approvals if a.id == approval_id)
        assert decided_approval.status == ApprovalStatus.rejected
        assert decided_approval.reason == rejection_reason

        # Ledger remains zero
        run_refunds = await refund_rows_for_run(session, run_id)
        assert len(run_refunds) == 0

        # Assistant acknowledges rejection
        assistant_texts = [m.text for m in snapshot.messages if m.role == "assistant" and m.text]
        assert any(rejection_reason in t for t in assistant_texts)


async def test_zero_matching_orders_scenario(sessions: Sessions, client: AsyncClient) -> None:
    """When filters yield zero matching orders, the run completes with zero drafts and zero writes."""
    async with sessions.begin() as session:
        await seed_orders(session, FIXED_SEED_DATE)

    resp = await client.post(
        "/runs",
        json={"goal": "Find orders over $10000 that shipped late last month."},
    )
    assert resp.status_code == 202
    run_id = UUID(resp.json()["id"])

    provider = ScenarioProvider()
    async with sessions.begin() as session:
        run = await session.get_one(Run, run_id)
        run.status = "running"
    await execute_run(sessions, run_id, provider)

    async with sessions() as session:
        snapshot = await get_snapshot(session, run_id)
        assert snapshot is not None
        assert snapshot.status == RunStatus.completed
        assert len(await refund_rows_for_run(session, run_id)) == 0
