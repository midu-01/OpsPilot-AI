"""Streaming HTTP adapters for Responses and OpenAI-compatible Chat Completions."""

from __future__ import annotations

import json
import math
import re
from collections.abc import AsyncIterator
from typing import Any

import httpx

from app.agent.contracts import LLMProvider, ModelEvent, ModelEventType, ProviderMessage, ToolDefinition

_INVALID_TEXT = re.compile(r"[\x00\ud800-\udfff]")


class _ProtocolError(ValueError):
    """Use a fixed error message at the provider boundary."""


def _object(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _ProtocolError
    return value


def _string(value: Any) -> str:
    if not isinstance(value, str) or _INVALID_TEXT.search(value):
        raise _ProtocolError
    return value


def _wire_arguments(value: Any) -> str:
    """Keep the wire text for replay when PostgreSQL can store it."""
    if not isinstance(value, str):
        raise _ProtocolError
    # An empty argument string is itself invalid, so it cannot turn an unsafe request into a valid call.
    return "" if _INVALID_TEXT.search(value) else value


def _validate_jsonb(value: Any) -> None:
    if isinstance(value, str):
        _string(value)
    elif isinstance(value, dict):
        for key, member in value.items():
            _string(key)
            _validate_jsonb(member)
    elif isinstance(value, list):
        for member in value:
            _validate_jsonb(member)
    elif isinstance(value, float) and not math.isfinite(value):
        raise _ProtocolError


def _replay_item(item: dict[str, Any]) -> dict[str, Any]:
    """Allow only the fields required to continue this stateless tool conversation."""
    if item.get("status", "completed") != "completed":
        raise _ProtocolError
    kind = item["type"]
    if kind == "reasoning":
        return {
            "type": kind,
            "id": _string(item["id"]),
            "summary": [],
            "encrypted_content": _string(item["encrypted_content"]),
        }
    if kind == "function_call":
        return {
            "type": kind,
            "call_id": _string(item["call_id"]),
            "name": _string(item["name"]),
            "arguments": _wire_arguments(item["arguments"]),
        }
    if kind == "message" and item["role"] == "assistant":
        text = []
        for part in item["content"]:
            if part["type"] == "output_text":
                text.append(_string(part["text"]))
            elif part["type"] == "refusal":
                text.append(_string(part["refusal"]))
            else:
                raise _ProtocolError
        message = {"role": "assistant", "content": "".join(text)}
        if item.get("phase") in ("commentary", "final_answer"):
            message["phase"] = item["phase"]
        return message
    raise _ProtocolError


def _tool_call(call_id: str, name: str, raw: str) -> ModelEvent:
    if not _string(call_id).strip() or not _string(name).strip():
        raise _ProtocolError
    raw = _wire_arguments(raw)
    event = ModelEvent(ModelEventType.tool_call, call_id=call_id, tool_name=name, raw_arguments=raw)
    try:
        arguments = _object(json.loads(raw))
        _validate_jsonb(arguments)
        event.arguments = arguments
    except (ValueError, RecursionError):
        event.error_message = "Tool arguments must be a valid, storable JSON object."
    return event


def _token_count(value: Any) -> int | None:
    return value if type(value) is int and value >= 0 else None


def _usage(usage: dict[str, Any], input_key: str, output_key: str) -> ModelEvent:
    details = usage.get(f"{input_key}_details")
    return ModelEvent(
        ModelEventType.usage,
        input_tokens=_token_count(usage.get(input_key)),
        output_tokens=_token_count(usage.get(output_key)),
        cached_tokens=_token_count(details.get("cached_tokens")) if isinstance(details, dict) else None,
    )


async def _frames(response: httpx.Response) -> AsyncIterator[str]:
    """Join SSE data lines and dispatch only frames terminated by a blank line."""
    lines: list[str] = []
    async for line in response.aiter_lines():
        if line.startswith("data:"):
            lines.append(line[5:].removeprefix(" "))
        elif line == "" and lines:
            yield "\n".join(lines)
            lines.clear()


class _ChatTurn:
    path = "chat/completions"

    def __init__(self) -> None:
        self.calls: dict[int, dict[str, str]] = {}
        self.finish_reason: str | None = None
        self.usage: ModelEvent | None = None
        self.complete = False

    def payload(self, messages: list[ProviderMessage], tools: list[dict[str, Any]]) -> dict[str, Any]:
        history = []
        for message in messages:
            item: dict[str, Any] = {"role": message.role, "content": message.content}
            if message.tool_calls:
                item["tool_calls"] = message.tool_calls
            if message.tool_call_id:
                item["tool_call_id"] = message.tool_call_id
            if message.name and message.role != "tool":
                item["name"] = message.name
            history.append(item)
        payload: dict[str, Any] = {"messages": history, "stream_options": {"include_usage": True}}
        if tools:
            payload["tools"] = [{"type": "function", "function": t} for t in tools]
        return payload

    def consume(self, data: str) -> str | None:
        if data == "[DONE]":
            if self.finish_reason not in ("stop", "tool_calls") or (self.finish_reason == "tool_calls") != bool(
                self.calls
            ):
                raise _ProtocolError
            self.complete = True
            return None
        frame = _object(json.loads(data))
        if "error" in frame:
            raise _ProtocolError
        choices = frame["choices"]
        if not isinstance(choices, list):
            raise _ProtocolError
        if not choices:
            if self.finish_reason is not None:
                self.read_usage(frame)
            return None
        if len(choices) != 1 or self.finish_reason is not None:
            raise _ProtocolError
        choice = _object(choices[0])
        self.finish_reason = choice.get("finish_reason")
        if self.finish_reason is not None:
            self.read_usage(frame)
        delta = _object(choice["delta"])
        for fragment in delta.get("tool_calls") or []:
            index = fragment["index"]
            if type(index) is not int or index < 0:
                raise _ProtocolError
            call = self.calls.setdefault(index, {"id": "", "name": "", "arguments": ""})
            fn = _object(fragment.get("function") or {})
            call["id"] += fragment.get("id") or ""
            call["name"] += fn.get("name") or ""
            call["arguments"] += fn.get("arguments") or ""
        return delta.get("content")

    def read_usage(self, frame: dict[str, Any]) -> None:
        usage = frame.get("usage") or (frame.get("x_groq") or {}).get("usage")
        if usage:
            self.usage = _usage(_object(usage), "prompt_tokens", "completion_tokens")

    def finish(self) -> list[ModelEvent]:
        events = [_tool_call(c["id"], c["name"], c["arguments"]) for _, c in sorted(self.calls.items())]
        return [*events, ModelEvent(ModelEventType.turn_complete)]


class _ResponsesTurn:
    path = "responses"

    def __init__(self) -> None:
        self.output: list[dict[str, Any]] = []
        self.text: list[str] = []
        self.usage: ModelEvent | None = None
        self.complete = False

    def payload(self, messages: list[ProviderMessage], tools: list[dict[str, Any]]) -> dict[str, Any]:
        history: list[dict[str, Any]] = []
        for message in messages:
            if message.role == "assistant" and message.response_items:
                history.extend(message.response_items)
                continue
            if message.role == "tool":
                history.append(
                    {"type": "function_call_output", "call_id": message.tool_call_id, "output": message.content or ""}
                )
                continue
            if message.content is not None:
                history.append({"role": message.role, "content": message.content})
            for call in message.tool_calls:
                fn = call["function"]
                history.append(
                    {"type": "function_call", "call_id": call["id"], "name": fn["name"], "arguments": fn["arguments"]}
                )
        return {
            "input": history,
            "tools": [{"type": "function", **t, "strict": False} for t in tools],
            "store": False,
            "include": ["reasoning.encrypted_content"],
        }

    def consume(self, data: str) -> str | None:
        frame = _object(json.loads(data))
        event_type = frame["type"]
        if event_type in ("response.output_text.delta", "response.refusal.delta"):
            delta = _string(frame["delta"])
            self.text.append(delta)
            return delta
        if event_type == "error":
            raise _ProtocolError
        if event_type in ("response.completed", "response.failed", "response.incomplete"):
            response = _object(frame["response"])
            if response.get("usage"):
                self.usage = _usage(_object(response["usage"]), "input_tokens", "output_tokens")
            if event_type != "response.completed":
                raise _ProtocolError
            if response.get("status", "completed") != "completed" or not isinstance(response["output"], list):
                raise _ProtocolError
            # This event contains the authoritative, reassembled output, including calls and encrypted reasoning.
            self.output = [_replay_item(_object(item)) for item in response["output"]]
            emitted = "".join(self.text)
            final_text = "".join(item["content"] for item in self.output if item.get("role") == "assistant")
            if not final_text.startswith(emitted):
                raise _ProtocolError
            self.complete = True
            return final_text[len(emitted) :]
        return None

    def finish(self) -> list[ModelEvent]:
        events = [
            _tool_call(item["call_id"], item["name"], item["arguments"])
            for item in self.output
            if item.get("type") == "function_call"
        ]
        return [*events, ModelEvent(ModelEventType.turn_complete, response_items=self.output)]


class _AnthropicTurn:
    path = "messages"

    def __init__(self) -> None:
        self.calls: dict[int, dict[str, str]] = {}
        self.input_tokens: int | None = None
        self.output_tokens: int | None = None
        self.usage: ModelEvent | None = None
        self.complete = False

    def payload(self, messages: list[ProviderMessage], tools: list[dict[str, Any]]) -> dict[str, Any]:
        system_prompt = ""
        anthropic_messages: list[dict[str, Any]] = []

        for m in messages:
            if m.role == "system":
                system_prompt = (m.content or "") if not system_prompt else f"{system_prompt}\n{m.content or ''}"
            elif m.role == "user":
                anthropic_messages.append({"role": "user", "content": m.content or ""})
            elif m.role == "assistant":
                content_blocks: list[dict[str, Any]] = []
                if m.content:
                    content_blocks.append({"type": "text", "text": m.content})
                for tc in m.tool_calls:
                    fn = tc.get("function", {})
                    raw_args = fn.get("arguments", "{}")
                    try:
                        args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
                    except Exception:
                        args = {}
                    content_blocks.append(
                        {
                            "type": "tool_use",
                            "id": tc.get("id", ""),
                            "name": fn.get("name", ""),
                            "input": args if isinstance(args, dict) else {},
                        }
                    )
                anthropic_messages.append(
                    {
                        "role": "assistant",
                        "content": content_blocks if content_blocks else (m.content or ""),
                    }
                )
            elif m.role == "tool":
                call_id = m.tool_call_id or ""
                res_content = m.content or ""
                tool_block = {
                    "type": "tool_result",
                    "tool_use_id": call_id,
                    "content": res_content,
                }
                if (
                    anthropic_messages
                    and anthropic_messages[-1]["role"] == "user"
                    and isinstance(anthropic_messages[-1]["content"], list)
                ):
                    anthropic_messages[-1]["content"].append(tool_block)
                else:
                    anthropic_messages.append(
                        {
                            "role": "user",
                            "content": [tool_block],
                        }
                    )

        anthropic_tools = [
            {
                "name": t["name"],
                "description": t["description"],
                "input_schema": t["parameters"],
            }
            for t in tools
        ]

        body: dict[str, Any] = {
            "max_tokens": 4096,
            "messages": anthropic_messages,
        }
        if system_prompt:
            body["system"] = system_prompt
        if anthropic_tools:
            body["tools"] = anthropic_tools
        return body

    def consume(self, data: str) -> str | None:
        try:
            event = json.loads(data)
        except Exception:
            return None

        event_type = event.get("type")
        if event_type == "message_start":
            msg = event.get("message", {})
            u = msg.get("usage", {})
            self.input_tokens = _token_count(u.get("input_tokens"))
            return None

        if event_type == "content_block_start":
            idx = event.get("index", 0)
            block = event.get("content_block", {})
            if block.get("type") == "tool_use":
                self.calls[idx] = {
                    "id": _string(block.get("id", "")),
                    "name": _string(block.get("name", "")),
                    "arguments": "",
                }
            return None

        if event_type == "content_block_delta":
            idx = event.get("index", 0)
            delta = event.get("delta", {})
            delta_type = delta.get("type")
            if delta_type == "text_delta":
                return _string(delta.get("text", ""))
            if delta_type == "input_json_delta" and idx in self.calls:
                self.calls[idx]["arguments"] += delta.get("partial_json", "")
            return None

        if event_type == "message_delta":
            u = event.get("usage", {})
            self.output_tokens = _token_count(u.get("output_tokens"))
            if self.input_tokens is not None or self.output_tokens is not None:
                self.usage = ModelEvent(
                    ModelEventType.usage,
                    input_tokens=self.input_tokens,
                    output_tokens=self.output_tokens,
                )
            return None

        if event_type == "message_stop":
            self.complete = True
            return None

        return None

    def finish(self) -> list[ModelEvent]:
        events = [
            _tool_call(call["id"], call["name"], call["arguments"])
            for call in self.calls.values()
        ]
        return [*events, ModelEvent(ModelEventType.turn_complete)]


class StreamingProvider:
    def __init__(
        self,
        provider: str,
        model: str,
        api_key: str,
        base_url: str,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if provider not in {"openai", "groq", "omniroute", "anthropic"}:
            raise ValueError("Unsupported provider.")
        self.provider = provider
        self.model = model
        self._api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.transport = transport

    async def stream_turn(
        self, messages: list[ProviderMessage], tool_definitions: list[ToolDefinition]
    ) -> AsyncIterator[ModelEvent]:
        if self.provider == "anthropic":
            turn: _ResponsesTurn | _ChatTurn | _AnthropicTurn = _AnthropicTurn()
            headers = {
                "Accept": "text/event-stream",
                "x-api-key": self._api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            }
        elif self.provider == "openai":
            turn = _ResponsesTurn()
            headers = {"Accept": "text/event-stream"}
            if self._api_key:
                headers["Authorization"] = f"Bearer {self._api_key}"
        else:
            turn = _ChatTurn()
            headers = {"Accept": "text/event-stream"}
            if self._api_key:
                headers["Authorization"] = f"Bearer {self._api_key}"
        tools = [
            {"name": t.name, "description": t.description, "parameters": t.parameters_schema} for t in tool_definitions
        ]
        error = "The provider returned an invalid or incomplete stream."
        reported_usage = None
        try:
            payload = {"model": self.model, "stream": True, **turn.payload(messages, tools)}
            if self.provider == "groq" and self.model in {"openai/gpt-oss-20b", "openai/gpt-oss-120b"}:
                payload["include_reasoning"] = False
            # The runner owns the configurable deadline for the whole turn.
            async with (
                httpx.AsyncClient(transport=self.transport, timeout=None) as client,
                client.stream("POST", f"{self.base_url}/{turn.path}", json=payload, headers=headers) as response,
            ):
                response.raise_for_status()
                async for data in _frames(response):
                    delta = turn.consume(data)
                    if turn.usage is not None and turn.usage != reported_usage:
                        reported_usage = turn.usage
                        yield reported_usage
                    if delta:
                        yield ModelEvent(ModelEventType.text_delta, text=_string(delta))
                    if turn.complete:
                        break
            if not turn.complete:
                raise _ProtocolError
            events = turn.finish()
        except httpx.HTTPStatusError as exc:
            error = f"The provider returned HTTP {exc.response.status_code}."
        except httpx.HTTPError:
            error = "The provider connection failed."
        except (ValueError, KeyError, TypeError, AttributeError, IndexError, RecursionError):
            pass
        else:
            for event in events:
                yield event
            return
        # A terminal frame can report valid counts alongside a failure or invalid output.
        if turn.usage is not None and turn.usage != reported_usage:
            yield turn.usage
        yield ModelEvent(ModelEventType.error, error_message=error)


def make_provider(provider: str, model: str, api_key: str, base_url: str) -> LLMProvider:
    return StreamingProvider(provider, model, api_key, base_url)
