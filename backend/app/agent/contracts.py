"""Provider interface and model events – the streaming boundary contract."""

from __future__ import annotations

from collections.abc import AsyncIterator
from copy import deepcopy
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Protocol

# ---------------------------------------------------------------------------
# Normalized model events emitted by any provider
# ---------------------------------------------------------------------------


class ModelEventType(StrEnum):
    """Types of events a provider emits during one model turn."""

    text_delta = "text_delta"
    tool_call = "tool_call"
    usage = "usage"
    turn_complete = "turn_complete"
    error = "error"


@dataclass
class ModelEvent:
    """A single normalized event from the model provider."""

    type: ModelEventType
    # text_delta
    text: str = ""
    # tool_call
    call_id: str = ""
    tool_name: str = ""
    arguments: dict[str, Any] = field(default_factory=dict)
    # usage
    input_tokens: int = 0
    output_tokens: int = 0
    cached_tokens: int = 0
    # error
    error_message: str = ""


# ---------------------------------------------------------------------------
# Tool definition for the provider
# ---------------------------------------------------------------------------


@dataclass
class ToolDefinition:
    """Metadata for a tool that the provider can call."""

    name: str
    description: str
    parameters_schema: dict[str, Any]
    requires_approval: bool = False


# ---------------------------------------------------------------------------
# Messages sent to the provider
# ---------------------------------------------------------------------------


@dataclass
class ProviderMessage:
    """A message in the conversation history sent to the model."""

    role: str  # "system", "user", "assistant", "tool"
    content: str | None = None
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    tool_call_id: str | None = None
    name: str | None = None


# ---------------------------------------------------------------------------
# Provider interface
# ---------------------------------------------------------------------------


class LLMProvider(Protocol):
    """A provider immediately returns an async iterator for one model turn."""

    def stream_turn(
        self,
        messages: list[ProviderMessage],
        tool_definitions: list[ToolDefinition],
    ) -> AsyncIterator[ModelEvent]: ...


class FakeProvider:
    """Replay one scripted turn per request and preserve its input messages."""

    def __init__(self, scripted_turns: list[list[ModelEvent]] | None = None) -> None:
        self.scripted_turns = deepcopy(scripted_turns or [])
        self.call_index = 0
        self.received_messages: list[list[ProviderMessage]] = []

    async def stream_turn(
        self,
        messages: list[ProviderMessage],
        tool_definitions: list[ToolDefinition],
    ) -> AsyncIterator[ModelEvent]:
        self.received_messages.append(deepcopy(messages))
        if self.call_index >= len(self.scripted_turns):
            raise RuntimeError("No more scripted provider turns")
        events = self.scripted_turns[self.call_index]
        self.call_index += 1
        for event in events:
            yield event
