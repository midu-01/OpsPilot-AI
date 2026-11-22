"""Unit tests for the versioned run event envelope and SSE formatting."""

from datetime import UTC, datetime
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.runs.schemas import EventType, RunEvent

NOW = datetime.now(UTC)


def test_valid_event_types_and_defaults() -> None:
    run_id = uuid4()
    for event_type in EventType:
        event = RunEvent(
            run_id=run_id,
            sequence=1,
            type=event_type,
            occurred_at=NOW,
            payload={"key": "value", "count": 42, "flag": True, "items": [1, 2, 3]},
        )
        assert event.schema_version == 1
        assert event.run_id == run_id
        assert event.sequence == 1
        assert event.type == event_type
        assert event.occurred_at == NOW
        assert event.payload["count"] == 42


def test_invalid_event_types_rejected() -> None:
    with pytest.raises(ValidationError) as exc:
        RunEvent.model_validate(
            {"run_id": uuid4(), "sequence": 1, "type": "invalid.event.type", "occurred_at": NOW}
        )
    assert "Input should be 'run.queued'" in str(exc.value)


@pytest.mark.parametrize("invalid_seq", [0, -1, -42])
def test_sequence_must_be_strictly_positive(invalid_seq: int) -> None:
    with pytest.raises(ValidationError):
        RunEvent.model_validate(
            {"run_id": uuid4(), "sequence": invalid_seq, "type": EventType.run_queued, "occurred_at": NOW}
        )


def test_schema_version_must_be_one() -> None:
    with pytest.raises(ValidationError):
        RunEvent.model_validate(
            {"run_id": uuid4(), "sequence": 1, "type": EventType.run_queued, "schema_version": 2, "occurred_at": NOW}
        )


def test_unaware_datetime_rejected() -> None:
    naive = datetime(2026, 11, 22, 12, 0, 0)
    with pytest.raises(ValidationError):
        RunEvent.model_validate(
            {"run_id": uuid4(), "sequence": 1, "type": EventType.run_queued, "occurred_at": naive}
        )


def test_event_sse_formatting_and_roundtrip() -> None:
    run_id = uuid4()
    event = RunEvent(
        run_id=run_id,
        sequence=12,
        type=EventType.tool_completed,
        occurred_at=datetime(2026, 11, 22, 12, 0, 0, tzinfo=UTC),
        payload={"tool": "query_orders", "result": {"orders": []}},
    )
    sse = event.to_sse()
    assert sse.startswith("id: 12\nevent: tool.completed\ndata: {")
    assert sse.endswith("}\n\n")

    lines = sse.strip().split("\n")
    assert lines[0] == "id: 12"
    assert lines[1] == "event: tool.completed"
    assert lines[2].startswith("data: ")

    data_json = lines[2][len("data: ") :]
    parsed = RunEvent.model_validate_json(data_json)
    assert parsed.run_id == run_id
    assert parsed.sequence == 12
    assert parsed.type == EventType.tool_completed
    assert parsed.occurred_at == event.occurred_at
    assert parsed.payload == event.payload
