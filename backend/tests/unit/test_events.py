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
        RunEvent.model_validate({"run_id": uuid4(), "sequence": 1, "type": "invalid.event.type", "occurred_at": NOW})
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
        RunEvent.model_validate({"run_id": uuid4(), "sequence": 1, "type": EventType.run_queued, "occurred_at": naive})


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


async def test_event_broker_subscribe_notify_unsubscribe() -> None:
    from app.runs.events import EventBroker

    broker = EventBroker()
    run_id1 = uuid4()
    run_id2 = uuid4()

    sub1_run1 = await broker.subscribe(run_id1)
    sub2_run1 = await broker.subscribe(run_id1)
    sub1_run2 = await broker.subscribe(run_id2)

    assert not sub1_run1.is_set()
    assert not sub2_run1.is_set()
    assert not sub1_run2.is_set()

    # Notify run 1 only
    broker.notify(run_id1)
    assert sub1_run1.is_set()
    assert sub2_run1.is_set()
    assert not sub1_run2.is_set()

    # Unsubscribe sub1
    await broker.unsubscribe(run_id1, sub1_run1)
    sub1_run1.clear()
    broker.notify(run_id1)
    assert not sub1_run1.is_set()  # unsubscribed

    # Unsubscribe sub2 - cleans up run_id1 entry
    await broker.unsubscribe(run_id1, sub2_run1)
    assert run_id1 not in broker._subscribers


async def test_event_post_commit_and_rollback_hooks() -> None:
    from unittest.mock import MagicMock

    from sqlalchemy.orm import Session

    from app.runs.events import _register_post_commit_notification, get_broker

    run_id = uuid4()
    mock_session = MagicMock()
    mock_session.info = {}
    mock_session.sync_session = Session()

    broker = get_broker()
    sub = await broker.subscribe(run_id)
    try:
        # Register notification hook
        _register_post_commit_notification(mock_session, run_id)
        assert run_id in mock_session.info["runs_to_notify"]

        # Simulate rollback: clears runs_to_notify
        mock_session.sync_session.dispatch.after_rollback()
        assert "runs_to_notify" not in mock_session.info
        assert not sub.is_set()

        # Register again and simulate commit
        _register_post_commit_notification(mock_session, run_id)
        mock_session.sync_session.dispatch.after_commit()
        assert sub.is_set()
    finally:
        await broker.unsubscribe(run_id, sub)
