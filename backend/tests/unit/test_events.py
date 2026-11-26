"""Unit tests for the versioned run event envelope and the run stream's messages."""

import json
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.runs.schemas import EventType, RunEvent, StreamKeepalive, StreamReady

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


def test_an_event_message_is_its_json_and_round_trips() -> None:
    run_id = uuid4()
    event = RunEvent(
        run_id=run_id,
        sequence=12,
        type=EventType.tool_completed,
        occurred_at=datetime(2026, 11, 22, 12, 0, 0, tzinfo=UTC),
        payload={"tool": "query_orders", "result": {"orders": []}},
    )
    message = json.loads(event.model_dump_json())

    # One WebSocket text frame: the console tells messages apart by "type" alone.
    assert message == {
        "schema_version": 1,
        "run_id": str(run_id),
        "sequence": 12,
        "type": "tool.completed",
        "occurred_at": "2026-11-22T12:00:00Z",
        "payload": {"tool": "query_orders", "result": {"orders": []}},
    }
    assert RunEvent.model_validate_json(event.model_dump_json()) == event


def test_control_messages_cannot_be_mistaken_for_events() -> None:
    assert json.loads(StreamReady().model_dump_json()) == {"type": "stream.ready"}
    assert json.loads(StreamKeepalive().model_dump_json()) == {"type": "stream.keepalive"}
    event_types = {event_type.value for event_type in EventType}
    assert {StreamReady().type, StreamKeepalive().type}.isdisjoint(event_types)


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
