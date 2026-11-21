"""Exercise deadline handling and streaming boundaries without a database or API key."""

import asyncio
from collections.abc import AsyncIterator
from contextlib import aclosing

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent.contracts import FakeProvider, LLMProvider, ModelEvent, ModelEventType, ProviderMessage, ToolDefinition
from app.agent.loop import MAX_DELTA_CHARS, Execution, RunFailure
from app.models import Run


def execution(provider: LLMProvider) -> Execution:
    run = Run(max_active_run_seconds=5, model_timeout_seconds=4, active_elapsed_ms=0)
    return Execution(async_sessionmaker[AsyncSession](), run, provider, [], 0, None)


def delta(text: str) -> ModelEvent:
    return ModelEvent(ModelEventType.text_delta, text=text)


async def test_text_is_bounded_and_precedes_the_tool_request() -> None:
    text = "x" * (MAX_DELTA_CHARS * 2 + 7)
    tool = ModelEvent(ModelEventType.tool_call, call_id="a", tool_name="date_math")
    end = ModelEvent(ModelEventType.turn_complete)
    runner = execution(FakeProvider([[delta("first"), delta(text), tool, delta("last"), end]]))
    events = [event async for event in runner.model_events()]
    assert events == [
        delta("first"),
        delta("x" * MAX_DELTA_CHARS),
        delta("x" * MAX_DELTA_CHARS),
        delta("xxxxxxx"),
        tool,
        delta("last"),
        end,
    ]


async def test_pending_text_is_published_while_the_provider_is_silent() -> None:
    resume = asyncio.Event()

    class StalledProvider:
        async def stream_turn(
            self, messages: list[ProviderMessage], tool_definitions: list[ToolDefinition]
        ) -> AsyncIterator[ModelEvent]:
            yield delta("first")
            yield delta("second")
            await resume.wait()
            yield ModelEvent(ModelEventType.turn_complete)

    async with aclosing(execution(StalledProvider()).model_events()) as events:
        assert await anext(events) == delta("first")
        assert await asyncio.wait_for(anext(events), 1) == delta("second")
        resume.set()
        assert (await anext(events)).type == ModelEventType.turn_complete


async def test_pending_text_survives_an_unexpected_provider_error() -> None:
    class BrokenProvider:
        async def stream_turn(
            self, messages: list[ProviderMessage], tool_definitions: list[ToolDefinition]
        ) -> AsyncIterator[ModelEvent]:
            yield delta("first")
            yield delta("one")
            yield delta(" two")
            raise ConnectionError("private provider detail")

    async with aclosing(execution(BrokenProvider()).model_events()) as events:
        assert await anext(events) == delta("first")
        assert await anext(events) == delta("one two")
        with pytest.raises(RunFailure) as error:
            await anext(events)
    assert error.value.code == "MODEL_ERROR" and "private provider detail" not in str(error.value)
