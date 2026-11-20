from datetime import UTC, datetime
from uuid import uuid4

import pytest
from pydantic import TypeAdapter, ValidationError

from app.agent.contracts import FakeProvider, LLMProvider, ModelEvent, ModelEventType, ProviderMessage
from app.config import Settings
from app.runs.schemas import ApprovalAction, RunCreate, RunEvent, RunSnapshot, ToolFailure, ToolResult

NOW = datetime.now(UTC)


def test_validate_actions_before_execution() -> None:
    assert RunCreate(goal="  Show late orders  ").goal == "Show late orders"
    approval_id = uuid4()
    assert ApprovalAction.model_validate({"approval_id": approval_id, "decision": "approve"}).reason is None
    assert (
        ApprovalAction.model_validate(
            {"approval_id": approval_id, "decision": "reject", "reason": "  Already refunded  "}
        ).reason
        == "Already refunded"
    )
    for reason in [None, "", "   "]:
        with pytest.raises(ValidationError):
            ApprovalAction.model_validate({"approval_id": approval_id, "decision": "reject", "reason": reason})
    with pytest.raises(ValidationError):
        ApprovalAction.model_validate({"approval_id": approval_id, "decision": "approve", "arguments": {"amount": 20}})
    for goal in ["   ", "x" * 2001]:
        with pytest.raises(ValidationError):
            RunCreate(goal=goal)


@pytest.fixture
def snapshot() -> dict[str, object]:
    return dict(
        id=uuid4(),
        goal="Track order",
        status="queued",
        provider="fake",
        model="scripted",
        reference_time=NOW,
        business_timezone="UTC",
        max_agent_steps=20,
        max_tool_calls=40,
        created_at=NOW,
        updated_at=NOW,
    )


def test_snapshot_cursor_and_event_sequence(snapshot: dict[str, object]) -> None:
    assert RunSnapshot.model_validate(snapshot).snapshot_cursor == 0
    with pytest.raises(ValidationError):
        RunSnapshot.model_validate({**snapshot, "snapshot_cursor": -1})
    event = dict(run_id=snapshot["id"], sequence=1, type="run.queued", occurred_at=NOW)
    assert RunEvent.model_validate(event).schema_version == 1
    invalid_events: list[dict[str, object]] = [{"sequence": 0}, {"schema_version": 2}, {"type": "unrecognized"}]
    for invalid in invalid_events:
        with pytest.raises(ValidationError):
            RunEvent.model_validate({**event, **invalid})


def test_replay_completed_approval_and_event_history(snapshot: dict[str, object]) -> None:
    approval = dict(
        id=uuid4(),
        tool_call_id=uuid4(),
        tool_name="issue_refund",
        proposed_arguments={"order": "A"},
        status="rejected",
        reason="Already refunded",
        decided_at=NOW,
    )
    event = dict(run_id=snapshot["id"], occurred_at=NOW, payload={"approval_id": str(approval["id"])})
    requested = {**event, "sequence": 1, "type": "approval.required"}
    decided = {**event, "sequence": 2, "type": "approval.decided"}
    history = dict(**snapshot, approvals=[approval], snapshot_cursor=2, events=[requested, decided])
    replay = RunSnapshot.model_validate_json(RunSnapshot.model_validate(history).model_dump_json())
    assert replay.pending_approval is None
    assert replay.approvals[0].reason == "Already refunded"
    assert replay.events[-1].payload["approval_id"] == str(replay.approvals[0].id)
    invalid_traces = [
        [decided, requested],
        [decided, decided],
        [requested],
        [requested, {**decided, "run_id": uuid4()}],
    ]
    for events in invalid_traces:
        with pytest.raises(ValidationError):
            RunSnapshot.model_validate({**history, "events": events})


def test_tool_result_discriminates_success_and_error() -> None:
    adapter = TypeAdapter[ToolResult](ToolResult)
    result = adapter.validate_python({"ok": False, "error": {"code": "UNKNOWN_ORDER", "message": "Unknown order"}})
    assert isinstance(result, ToolFailure)
    assert result.error.code == "UNKNOWN_ORDER"
    with pytest.raises(ValidationError):
        adapter.validate_python({"ok": False, "data": {}})


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("business_timezone", "Wrong/Zone"),
        ("max_tool_calls", 0),
        ("database_url", "sqlite:///ops"),
        ("database_url", "postgresql+asyncpg://db"),
        ("cors_allowed_origins", "*"),
        ("cors_allowed_origins", "http://example.org/path"),
    ],
)
def test_validate_configuration(field: str, value: object) -> None:
    with pytest.raises(ValidationError):
        Settings.model_validate({field: value})


async def test_scripted_provider_replays_complete_turns_and_preserves_history() -> None:
    tools = [
        ModelEvent(type=ModelEventType.tool_call, call_id="one", tool_name="query_orders"),
        ModelEvent(type=ModelEventType.tool_call, call_id="two", tool_name="search_policies"),
        ModelEvent(type=ModelEventType.turn_complete),
    ]
    answer = [
        ModelEvent(type=ModelEventType.text_delta, text="Done"),
        ModelEvent(type=ModelEventType.usage, input_tokens=2, output_tokens=1),
        ModelEvent(type=ModelEventType.turn_complete),
    ]
    fake = FakeProvider([tools, answer])
    provider: LLMProvider = fake
    history = [ProviderMessage(role="user", content="Help")]
    assert [event async for event in provider.stream_turn(history, [])] == tools
    history[0].content = "Changed"
    assert [event async for event in provider.stream_turn(history, [])] == answer
    assert [turn[0].content for turn in fake.received_messages] == ["Help", "Changed"]
    with pytest.raises(RuntimeError, match="No more scripted"):
        _ = [event async for event in provider.stream_turn(history, [])]
