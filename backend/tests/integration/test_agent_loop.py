"""Run the model loop against real persisted runs and the deterministic provider."""

import asyncio
import json
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from uuid import UUID

import pytest
from pydantic import JsonValue
from sqlalchemy import event, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent.contracts import FakeProvider, ModelEvent, ModelEventType, ProviderMessage, ToolDefinition
from app.agent.loop import execute_run
from app.models import Message, ModelCall, Order, Refund, Run, RunEventRecord
from app.runs.schemas import EventType, RunSnapshot
from app.runs.service import create_run, get_snapshot
from app.tools import ToolRegistry

type Sessions = async_sessionmaker[AsyncSession]
END = ModelEvent(type=ModelEventType.turn_complete)
ANSWER = ModelEvent(type=ModelEventType.text_delta, text="Done.")
USAGE = ModelEvent(type=ModelEventType.usage, input_tokens=10, output_tokens=3, cached_tokens=2)


async def claimed(sessions: Sessions, **limits: int) -> UUID:
    async with sessions() as session:
        summary = await create_run(session, "Investigate late orders")
        async with session.begin():
            run = await session.get_one(Run, summary.id)
            run.status = "running"
            for key, value in limits.items():
                setattr(run, key, value)
    return summary.id


async def snapshot(sessions: Sessions, run_id: UUID) -> RunSnapshot:
    async with sessions() as session:
        result = await get_snapshot(session, run_id)
        assert result is not None
        return result


def call(call_id: str, name: str, **arguments: object) -> ModelEvent:
    return ModelEvent(type=ModelEventType.tool_call, call_id=call_id, tool_name=name, arguments=arguments)


async def test_tools_feed_actual_results_to_next_turn(sessions: Sessions) -> None:
    run_id = await claimed(sessions)
    shipped = datetime(2026, 1, 1, tzinfo=UTC)
    async with sessions.begin() as session:
        session.add(
            Order(
                id="test-order",
                customer_name="A",
                customer_email="a@example.org",
                amount_minor=50000,
                status="shipped",
                promised_ship_at=shipped,
                shipped_at=shipped,
            )
        )
    fake = FakeProvider(
        [
            [call("d", "date_math", operation="add_days", reference_date="2026-01-01", days=3), USAGE, END],
            [call("q", "query_orders", limit=1), USAGE, END],
            [ANSWER, USAGE, END],
        ]
    )
    await execute_run(sessions, run_id, fake)
    trace = await snapshot(sessions, run_id)
    assert (trace.status, trace.step_count, trace.tool_call_count, trace.total_tokens) == ("completed", 3, 2, 39)
    assert [m.role for m in trace.messages] == ["user", "assistant", "tool", "assistant", "tool", "assistant"]
    date_result = fake.received_messages[1][-1]
    assert date_result.tool_call_id == "d"
    assert json.loads(date_result.content or "")["data"]["result"] == "2026-01-04"
    orders = fake.received_messages[2][-1]
    assert orders.tool_call_id == "q" and "test-order" in (orders.content or "")
    assert trace.messages[-1].text == "Done."
    assert trace.events[-1].type == EventType.run_completed
    assert [e.sequence for e in trace.events] == list(range(1, trace.snapshot_cursor + 1))


async def test_invalid_unknown_and_write_requests_are_observations(sessions: Sessions) -> None:
    run_id = await claimed(sessions)
    malformed = call("a", "date_math")
    malformed.raw_arguments = '{"operation":'
    malformed.error_message = "Invalid JSON arguments"
    fake = FakeProvider(
        [
            [
                malformed,
                call("b", "unknown"),
                call("c", "date_math", operation="typo"),
                call("d", "issue_refund", order_id="x", reason="late"),
                END,
            ],
            [ANSWER, END],
        ]
    )
    await execute_run(sessions, run_id, fake)
    trace = await snapshot(sessions, run_id)
    assert trace.status == "completed"
    messages = fake.received_messages[1]
    assistant = next(m for m in messages if m.role == "assistant")
    assert assistant.tool_calls[0]["function"]["arguments"] == malformed.raw_arguments
    observations = [m for m in messages if m.role == "tool"]
    assert [m.tool_call_id for m in observations] == ["a", "b", "c", "d"]
    assert [json.loads(m.content or "")["error"]["code"] for m in observations] == [
        "INVALID_ARGUMENTS",
        "UNKNOWN_TOOL",
        "INVALID_ARGUMENTS",
        "REFUND_INELIGIBLE",
    ]
    assert [c.status for c in trace.messages[1].tool_calls] == ["failed"] * 4
    async with sessions() as session:
        assert await session.scalar(select(func.count()).select_from(Refund)) == 0


async def test_tool_exception_is_recoverable(sessions: Sessions, monkeypatch: pytest.MonkeyPatch) -> None:
    async def broken(*args: object) -> None:
        raise RuntimeError("private database detail")

    monkeypatch.setattr(ToolRegistry, "dispatch", broken)
    run_id = await claimed(sessions)
    fake = FakeProvider([[call("1", "date_math", operation="previous_month"), END], [ANSWER, END]])
    await execute_run(sessions, run_id, fake)
    trace = await snapshot(sessions, run_id)
    assert trace.status == "completed"
    observation = fake.received_messages[1][-1].content or ""
    assert json.loads(observation)["error"]["code"] == "TOOL_ERROR"
    assert "private database detail" not in observation


async def test_step_limit_and_missing_usage(sessions: Sessions) -> None:
    run_id = await claimed(sessions, max_agent_steps=1)
    fake = FakeProvider([[call("d", "date_math", operation="previous_month"), END], [ANSWER, END]])
    await execute_run(sessions, run_id, fake)
    trace = await snapshot(sessions, run_id)
    assert fake.call_index == trace.step_count == 1
    assert trace.events[-1].payload["code"] == "MAX_AGENT_STEPS"
    async with sessions() as session:
        record = (await session.scalars(select(ModelCall))).one()
        assert record.status == "completed" and not record.usage_complete
        assert record.input_tokens is None and trace.estimated_cost_usd is None


async def test_tool_budget_inside_batch(sessions: Sessions) -> None:
    run_id = await claimed(sessions, max_tool_calls=1)
    fake = FakeProvider([[call("a", "date_math", operation="previous_month"), call("b", "query_orders"), END]])
    await execute_run(sessions, run_id, fake)
    trace = await snapshot(sessions, run_id)
    assert trace.tool_call_count == 1 and trace.step_count == 1
    assert trace.events[-1].payload["code"] == "MAX_TOOL_CALLS"
    assert [c.status for c in trace.messages[1].tool_calls] == ["completed", "failed"]
    assert [json.loads(m.text or "")["ok"] for m in trace.messages if m.role == "tool"] == [True, False]


async def test_active_budget_expires_during_tool(sessions: Sessions, monkeypatch: pytest.MonkeyPatch) -> None:
    started: list[str] = []

    async def slow_dispatch(registry: ToolRegistry, name: str, *args: object) -> None:
        started.append(name)
        await asyncio.Event().wait()

    monkeypatch.setattr(ToolRegistry, "dispatch", slow_dispatch)
    run_id = await claimed(sessions, max_active_run_seconds=1)
    fake = FakeProvider([[call("first", "query_orders"), call("second", "date_math"), END], [ANSWER, END]])
    await asyncio.wait_for(execute_run(sessions, run_id, fake), 5)
    trace = await snapshot(sessions, run_id)
    assert started == ["query_orders"]
    assert (trace.status, trace.step_count, trace.tool_call_count) == ("failed", 1, 1)
    assert trace.events[-1].payload["code"] == "MAX_ACTIVE_RUN_SECONDS"
    assert [c.status for c in trace.messages[1].tool_calls] == ["failed", "failed"]
    assert [json.loads(m.text or "")["error"]["code"] for m in trace.messages if m.role == "tool"] == [
        "MAX_ACTIVE_RUN_SECONDS",
        "MAX_ACTIVE_RUN_SECONDS",
    ]


async def test_exhausted_persisted_budget_skips_model(sessions: Sessions) -> None:
    run_id = await claimed(sessions, max_active_run_seconds=1, active_elapsed_ms=1000)
    fake = FakeProvider([[ANSWER, END]])
    await execute_run(sessions, run_id, fake)
    trace = await snapshot(sessions, run_id)
    assert fake.call_index == trace.step_count == 0
    assert trace.events[-1].payload["code"] == "MAX_ACTIVE_RUN_SECONDS"


async def test_stream_releases_database_connections_between_deltas(sessions: Sessions) -> None:
    run_id = await claimed(sessions)
    active_connections = 0
    observed: list[int] = []

    def checkout(*args: object) -> None:
        nonlocal active_connections
        active_connections += 1

    def checkin(*args: object) -> None:
        nonlocal active_connections
        active_connections -= 1

    class ProbeProvider:
        async def stream_turn(
            self, messages: list[ProviderMessage], tool_definitions: list[ToolDefinition]
        ) -> AsyncIterator[ModelEvent]:
            observed.append(active_connections)
            yield ANSWER
            observed.append(active_connections)
            trace = await snapshot(sessions, run_id)
            assert trace.status == "running" and trace.messages[-1].text == "Done."
            yield END

    async with sessions() as session:
        bind = session.get_bind()
    event.listen(bind, "checkout", checkout)
    event.listen(bind, "checkin", checkin)
    try:
        await execute_run(sessions, run_id, ProbeProvider())
    finally:
        event.remove(bind, "checkout", checkout)
        event.remove(bind, "checkin", checkin)
    assert observed == [0, 0]
    assert (await snapshot(sessions, run_id)).status == "completed"


@pytest.mark.parametrize(
    "events,code",
    [
        ([USAGE, END], "EMPTY_MODEL_OUTPUT"),
        ([USAGE, ModelEvent(type=ModelEventType.error, error_message="provider unavailable")], "MODEL_ERROR"),
        ([USAGE, ANSWER], "MODEL_ERROR"),
    ],
)
async def test_failed_model_turn_counts_usage(sessions: Sessions, events: list[ModelEvent], code: str) -> None:
    run_id = await claimed(sessions)
    await execute_run(sessions, run_id, FakeProvider([events]))
    trace = await snapshot(sessions, run_id)
    assert trace.status == "failed" and trace.events[-1].payload["code"] == code
    assert trace.step_count == 1 and trace.total_tokens == 13
    async with sessions() as session:
        record = (await session.scalars(select(ModelCall))).one()
        assert record.status == "failed" and record.completed_at is not None and record.usage_complete


class BlockingProvider:
    async def stream_turn(
        self, messages: list[ProviderMessage], tool_definitions: list[ToolDefinition]
    ) -> AsyncIterator[ModelEvent]:
        yield ModelEvent(type=ModelEventType.text_delta, text="Partial")
        await asyncio.Event().wait()


@pytest.mark.parametrize(
    "limits,code",
    [
        ({"model_timeout_seconds": 1}, "MODEL_TIMEOUT"),
        ({"max_active_run_seconds": 1, "active_elapsed_ms": 650}, "MAX_ACTIVE_RUN_SECONDS"),
    ],
)
async def test_timeout_preserves_partial_text(sessions: Sessions, limits: dict[str, int], code: str) -> None:
    run_id = await claimed(sessions, **limits)
    await asyncio.wait_for(execute_run(sessions, run_id, BlockingProvider()), 5)
    trace = await snapshot(sessions, run_id)
    assert trace.status == "failed" and trace.step_count == 1
    assert trace.events[-1].payload["code"] == code
    assert trace.active_elapsed_ms >= 990
    assert trace.messages[-1].text == "Partial"


async def test_many_small_deltas_preserve_text_with_fewer_events(sessions: Sessions) -> None:
    run_id = await claimed(sessions)
    fragments = [ModelEvent(ModelEventType.text_delta, text=str(i % 10)) for i in range(200)]
    await execute_run(sessions, run_id, FakeProvider([[*fragments, END]]))
    trace = await snapshot(sessions, run_id)
    batches = [e.payload["delta"] for e in trace.events if e.type == EventType.message_delta]
    expected = "".join(e.text for e in fragments)
    assert batches[0] == "0" and 2 <= len(batches) < len(fragments) // 2
    assert "".join(str(batch) for batch in batches) == trace.messages[-1].text == expected
    assert trace.status == "completed"


@pytest.mark.parametrize("broken_event", [EventType.message_delta, EventType.tool_completed])
async def test_storage_failure_hands_off_unfinished_work_to_recovery(
    sessions: Sessions, monkeypatch: pytest.MonkeyPatch, broken_event: EventType
) -> None:
    from app.agent import loop
    from app.agent.worker import recover

    run_id = await claimed(sessions)
    append = loop.append_event

    async def fail_once(
        session: AsyncSession, run_id: UUID, kind: EventType, payload: dict[str, JsonValue]
    ) -> RunEventRecord:
        if kind == broken_event:
            raise RuntimeError("simulated trace write failure")
        return await append(session, run_id, kind, payload)

    monkeypatch.setattr(loop, "append_event", fail_once)
    fake = FakeProvider([[call("a", "date_math", operation="previous_month"), ANSWER, END]])
    with pytest.raises(RuntimeError, match="trace write failure"):
        await execute_run(sessions, run_id, fake)
    assert (await snapshot(sessions, run_id)).status == "running"

    await recover(sessions)
    trace = await snapshot(sessions, run_id)
    assert trace.events[-1].type == EventType.run_failed
    assert trace.messages[1].tool_calls[0].status == "failed"
    assert json.loads(trace.messages[-1].text or "")["error"]["code"] == "PROCESS_RESTARTED"
    async with sessions() as session:
        attempt = (await session.scalars(select(ModelCall))).one()
        assert attempt.status != "running" and attempt.completed_at is not None
        assert not await session.scalar(select(Message.id).where(Message.status == "running"))
