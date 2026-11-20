"""Exercise provider wire formats over a real HTTPX streaming request and response."""

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest

from app.agent.contracts import ModelEvent, ModelEventType, ProviderMessage, ToolDefinition
from app.agent.providers import StreamingProvider

GROQ_MODEL = "openai/gpt-oss-20b"
MODELS = {"groq": GROQ_MODEL, "omniroute": "router-model", "openai": "gpt-5-mini"}
HISTORY = [ProviderMessage("system", "Use the order tool."), ProviderMessage("user", "Check order 42.")]
LOOKUP = ToolDefinition("lookup", "Look up an order", {"type": "object", "properties": {"id": {"type": "integer"}}})
SECRET = "test-only-private-detail"


def sse(*frames: dict[str, Any] | str) -> bytes:
    return "".join(
        f"data: {json.dumps(frame, ensure_ascii=False) if isinstance(frame, dict) else frame}\r\n\r\n"
        for frame in frames
    ).encode()


class FragmentedBody(httpx.AsyncByteStream):
    def __init__(self, body: bytes) -> None:
        self.body = body

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for start in range(0, len(self.body), 7):
            yield self.body[start : start + 7]


def scripted(provider: str, *bodies: bytes) -> tuple[StreamingProvider, list[httpx.Request]]:
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        body = bodies[len(requests)]
        requests.append(request)
        return httpx.Response(200, stream=FragmentedBody(body), headers={"content-type": "text/event-stream"})

    adapter = StreamingProvider(
        provider, MODELS[provider], "test-key", "https://provider.invalid/v1/", transport=httpx.MockTransport(respond)
    )
    return adapter, requests


def chunk(delta: dict[str, Any], finish: str | None = None, **extra: Any) -> dict[str, Any]:
    return {"choices": [{"index": 0, "delta": delta, "finish_reason": finish}], **extra}


def completed(output: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    return {"type": "response.completed", "response": {"status": "completed", "output": output, **extra}}


def call_item(raw: str) -> dict[str, Any]:
    return {"type": "function_call", "call_id": "call_1", "name": "lookup", "arguments": raw}


async def collect(adapter: StreamingProvider, history: list[ProviderMessage]) -> list[ModelEvent]:
    return [event async for event in adapter.stream_turn(history, [LOOKUP])]


@pytest.mark.parametrize("provider", ["groq", "omniroute"])
async def test_chat_tools_usage_and_two_turn_wire_history(provider: str) -> None:
    counts = {"prompt_tokens": 12, "completion_tokens": 5, "prompt_tokens_details": {"cached_tokens": 4}}
    final = chunk({}, "tool_calls")
    trailer = []
    if provider == "groq":
        final["x_groq"] = {"usage": counts}
    else:
        trailer.append({"choices": [], "usage": counts})
    opening = chunk(
        {
            "role": "assistant",
            "reasoning": SECRET,
            "tool_calls": [
                {"index": 1, "id": "call_2", "type": "function", "function": {"name": "lookup", "arguments": '{"id":'}},
                {"index": 0, "id": "call_", "type": "function", "function": {"name": "look", "arguments": '{"i'}},
            ],
        },
        usage={"prompt_tokens": 800},
    )
    closing = chunk(
        {
            "tool_calls": [
                {"index": 0, "id": "1", "function": {"name": "up", "arguments": 'd":42}'}},
                {"index": 1, "function": {"arguments": "43}"}},
            ]
        }
    )
    adapter, sent = scripted(
        provider,
        sse(opening, closing, final, *trailer, "[DONE]"),
        sse(chunk({"content": "পাঠানো হয়েছে"}, "stop"), "[DONE]"),
    )
    events = await collect(adapter, HISTORY)
    assert [event.type for event in events] == [
        ModelEventType.usage,
        ModelEventType.tool_call,
        ModelEventType.tool_call,
        ModelEventType.turn_complete,
    ]
    requests = events[1:3]
    assert [(e.call_id, e.tool_name, e.arguments) for e in requests] == [
        ("call_1", "lookup", {"id": 42}),
        ("call_2", "lookup", {"id": 43}),
    ]
    assert (events[0].input_tokens, events[0].output_tokens, events[0].cached_tokens) == (12, 5, 4)
    calls = [
        {"id": e.call_id, "type": "function", "function": {"name": e.tool_name, "arguments": e.raw_arguments}}
        for e in requests
    ]
    observations = [ProviderMessage("tool", "shipped", tool_call_id=e.call_id, name=e.tool_name) for e in requests]
    second = await collect(adapter, [*HISTORY, ProviderMessage("assistant", tool_calls=calls), *observations])
    assert second == [
        ModelEvent(ModelEventType.text_delta, text="পাঠানো হয়েছে"),
        ModelEvent(ModelEventType.turn_complete),
    ]
    assert all(request.url.path == "/v1/chat/completions" and request.method == "POST" for request in sent)
    assert sent[0].headers["authorization"] == "Bearer test-key"
    initial, followup = [json.loads(req.content) for req in sent]
    assert initial["model"] == MODELS[provider] and initial["stream"] is True
    assert initial["stream_options"] == {"include_usage": True}
    assert initial.get("include_reasoning") == (False if provider == "groq" else None)
    assert initial["tools"] == [
        {
            "type": "function",
            "function": {"name": "lookup", "description": LOOKUP.description, "parameters": LOOKUP.parameters_schema},
        }
    ]
    assert followup["messages"] == [
        {"role": "system", "content": HISTORY[0].content},
        {"role": "user", "content": HISTORY[1].content},
        {"role": "assistant", "content": None, "tool_calls": calls},
        {"role": "tool", "tool_call_id": "call_1", "content": "shipped"},
        {"role": "tool", "tool_call_id": "call_2", "content": "shipped"},
    ]
    assert SECRET not in repr(events) + repr(followup)


async def test_responses_replays_encrypted_reasoning_then_observation_in_output_order() -> None:
    reasoning = {"type": "reasoning", "id": "rs_1", "encrypted_content": "opaque-ciphertext", "summary": []}
    native_call = call_item('{"id":42}')
    message = {
        "type": "message",
        "role": "assistant",
        "phase": "commentary",
        "content": [{"type": "output_text", "text": "Checking."}],
    }
    adapter, sent = scripted(
        "openai",
        sse(
            {"type": "response.reasoning_text.delta", "delta": SECRET},
            {"type": "response.output_text.delta", "delta": "Checking."},
            {"type": "response.function_call_arguments.delta", "item_id": "fc_1", "delta": '{"id":'},
            {"type": "response.function_call_arguments.delta", "item_id": "fc_1", "delta": "42}"},
            completed(
                [
                    dict(
                        reasoning,
                        summary=[{"type": "summary_text", "text": SECRET}],
                        content=[{"type": "reasoning_text", "text": SECRET}],
                    ),
                    message,
                    native_call,
                ],
                usage={"input_tokens": 16, "output_tokens": 8, "input_tokens_details": {"cached_tokens": 0}},
            ),
        ),
        sse(
            {"type": "response.output_text.delta", "delta": "Ship"},
            completed(
                [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Shipped."}]}]
            ),
        ),
    )
    events = await collect(adapter, HISTORY)
    assert [e.type for e in events] == [
        ModelEventType.text_delta,
        ModelEventType.usage,
        ModelEventType.tool_call,
        ModelEventType.turn_complete,
    ]
    assert events[0].text == "Checking."
    assert events[2] == ModelEvent(
        ModelEventType.tool_call, tool_name="lookup", call_id="call_1", arguments={"id": 42}, raw_arguments='{"id":42}'
    )
    assert (events[1].input_tokens, events[1].output_tokens, events[1].cached_tokens) == (16, 8, 0)
    replay = events[3].response_items
    assert replay == [reasoning, {"role": "assistant", "content": "Checking.", "phase": "commentary"}, native_call]
    second = await collect(
        adapter,
        [
            *HISTORY,
            ProviderMessage("assistant", response_items=replay),
            ProviderMessage("tool", "shipped", tool_call_id="call_1"),
        ],
    )
    assert [e.type for e in second] == [
        ModelEventType.text_delta,
        ModelEventType.text_delta,
        ModelEventType.turn_complete,
    ]
    assert "".join(e.text for e in second) == "Shipped."
    assert [request.url.path for request in sent] == ["/v1/responses", "/v1/responses"]
    payload = json.loads(sent[1].content)
    assert payload["store"] is False and payload["include"] == ["reasoning.encrypted_content"]
    assert payload["tools"] == [
        {
            "type": "function",
            "name": "lookup",
            "description": LOOKUP.description,
            "parameters": LOOKUP.parameters_schema,
            "strict": False,
        }
    ]
    assert payload["input"] == [{"role": m.role, "content": m.content} for m in HISTORY] + replay + [
        {"type": "function_call_output", "call_id": "call_1", "output": "shipped"}
    ]
    assert SECRET not in repr(events) + repr(payload)


@pytest.mark.parametrize("raw", ["{", "[]", '{"id":NaN}', r'{"a":[{"b":"\u0000"}]}', r'{"\udfff":1}'])
@pytest.mark.parametrize("provider", ["groq", "openai"])
async def test_malformed_tool_arguments_can_be_reported_to_model(provider: str, raw: str) -> None:
    if provider == "openai":
        body = sse(completed([call_item(raw)]))
    else:
        fragment = {"index": 0, "id": "call_1", "function": {"name": "lookup", "arguments": raw}}
        body = sse(chunk({"tool_calls": [fragment]}, "tool_calls"), "[DONE]")
    adapter, _ = scripted(provider, body)
    request, done = await collect(adapter, HISTORY)
    assert request.type == ModelEventType.tool_call and request.raw_arguments == raw
    assert request.call_id == "call_1" and request.arguments == {} and request.error_message
    assert done.type == ModelEventType.turn_complete


async def test_interim_usage_alone_does_not_establish_final_counts() -> None:
    adapter, _ = scripted(
        "groq", sse(chunk({"content": "ok"}, x_groq={"usage": {"prompt_tokens": 99}}), chunk({}, "stop"), "[DONE]")
    )
    assert await collect(adapter, HISTORY) == [
        ModelEvent(ModelEventType.text_delta, text="ok"),
        ModelEvent(ModelEventType.turn_complete),
    ]


@pytest.mark.parametrize(
    ("provider", "broken"),
    [
        ("groq", sse(chunk({}, "stop"))),
        ("groq", sse(chunk({}, "stop"), "[DONE]").rstrip()),
        (
            "groq",
            sse(
                chunk({"tool_calls": [{"index": 0, "id": "call", "function": {"name": "lookup", "arguments": "{"}}]}),
                "[DONE]",
            ),
        ),
        ("omniroute", sse(chunk({}, "length"), "[DONE]")),
        ("openai", sse({"type": "response.function_call_arguments.done", "arguments": "{}"})),
        ("openai", sse(completed([dict(call_item("{}"), status="incomplete")]))),
        ("openai", sse({"type": "response.incomplete", "response": {"incomplete_details": {"reason": SECRET}}})),
        ("openai", sse({"type": "error", "message": SECRET})),
        ("groq", sse({"error": {"message": SECRET}})),
        ("openai", sse(SECRET)),
    ],
)
async def test_broken_stream_preserves_only_partial_visible_text(provider: str, broken: bytes) -> None:
    partial = (
        {"type": "response.output_text.delta", "delta": "Partial"}
        if provider == "openai"
        else chunk({"content": "Partial"})
    )
    adapter, _ = scripted(provider, sse(partial) + broken)
    assert await collect(adapter, HISTORY) == [
        ModelEvent(ModelEventType.text_delta, text="Partial"),
        ModelEvent(ModelEventType.error, error_message="The provider returned an invalid or incomplete stream."),
    ]


@pytest.mark.parametrize("http_status", [None, 401, 429, 503])
async def test_provider_http_failures_are_sanitized(http_status: int | None) -> None:
    def fail(request: httpx.Request) -> httpx.Response:
        if http_status is None:
            raise httpx.ReadError(SECRET, request=request)
        return httpx.Response(http_status, text=SECRET)

    adapter = StreamingProvider(
        "groq", GROQ_MODEL, SECRET, "https://provider.invalid/v1", transport=httpx.MockTransport(fail)
    )
    message = f"The provider returned HTTP {http_status}." if http_status else "The provider connection failed."
    assert await collect(adapter, HISTORY) == [ModelEvent(ModelEventType.error, error_message=message)]


@pytest.mark.parametrize("provider", ["groq", "openai"])
@pytest.mark.parametrize("field", ["call_id", "name", "arguments"])
@pytest.mark.parametrize("invalid", ["\x00", "\ud800"])
async def test_unstorable_literal_in_wire_call(provider: str, field: str, invalid: str) -> None:
    item = call_item("{}")
    item[field] = invalid
    if provider == "openai":
        frame = completed([item])
    else:
        fragment = {
            "index": 0,
            "id": item["call_id"],
            "function": {"name": item["name"], "arguments": item["arguments"]},
        }
        frame = chunk({"tool_calls": [fragment]}, "tool_calls")
    frames = [json.dumps(frame)]
    if provider == "groq":
        frames.append("[DONE]")
    adapter, _ = scripted(provider, sse(*frames))
    events = await collect(adapter, HISTORY)
    if field == "arguments":
        assert [e.type for e in events] == [ModelEventType.tool_call, ModelEventType.turn_complete]
        assert events[0].error_message and events[0].arguments == {} and events[0].raw_arguments == ""
        if provider == "openai":
            assert events[1].response_items[0]["arguments"] == ""
    else:
        assert events == [
            ModelEvent(ModelEventType.error, error_message="The provider returned an invalid or incomplete stream.")
        ]


async def test_groq_top_level_usage_without_cache_detail_remains_unknown() -> None:
    tool = {"index": 0, "id": "call_7", "function": {"name": "search_policies", "arguments": '{"query":"refund"}'}}
    adapter, _ = scripted(
        "groq",
        sse(
            chunk({"tool_calls": [tool]}, "tool_calls"),
            {"choices": [], "usage": {"prompt_tokens": 789, "completion_tokens": 99}},
            "[DONE]",
        ),
    )
    usage, request, done = await collect(adapter, HISTORY)
    assert request.tool_name == "search_policies" and request.arguments == {"query": "refund"}
    assert usage == ModelEvent(ModelEventType.usage, input_tokens=789, output_tokens=99, cached_tokens=None)
    assert done.type == ModelEventType.turn_complete


@pytest.mark.parametrize("status", ["incomplete", "failed"])
async def test_responses_preserves_terminal_usage_for_failed_turn(status: str) -> None:
    response = {
        "type": f"response.{status}",
        "response": {
            "status": status,
            "output": [call_item("{}")],
            "usage": {"input_tokens": 8, "output_tokens": 3},
            "error": {"message": SECRET},
        },
    }
    adapter, _ = scripted("openai", sse(response))
    assert await collect(adapter, HISTORY) == [
        ModelEvent(ModelEventType.usage, input_tokens=8, output_tokens=3),
        ModelEvent(ModelEventType.error, error_message="The provider returned an invalid or incomplete stream."),
    ]


@pytest.mark.parametrize("provider", ["openai", "omniroute"])
async def test_final_usage_retained_when_same_frame_has_invalid_tool_call(provider: str) -> None:
    if provider == "openai":
        body = sse(completed([dict(call_item("{}"), name=None)], usage={"input_tokens": 6, "output_tokens": 4}))
    else:
        body = sse(
            chunk({"tool_calls": [{"index": -1}]}, "tool_calls", usage={"prompt_tokens": 6, "completion_tokens": 4}),
            "[DONE]",
        )
    adapter, _ = scripted(provider, body)
    assert await collect(adapter, HISTORY) == [
        ModelEvent(ModelEventType.usage, input_tokens=6, output_tokens=4),
        ModelEvent(ModelEventType.error, error_message="The provider returned an invalid or incomplete stream."),
    ]


async def test_chat_length_limit_preserves_usage_with_incomplete_call() -> None:
    fragment = {"index": 0, "id": "call_1", "function": {"name": "lookup", "arguments": "{"}}
    finish = chunk(
        {"tool_calls": [fragment]}, "length", x_groq={"usage": {"prompt_tokens": 18, "completion_tokens": 5}}
    )
    adapter, _ = scripted("groq", sse(finish, "[DONE]"))
    assert await collect(adapter, HISTORY) == [
        ModelEvent(ModelEventType.usage, input_tokens=18, output_tokens=5),
        ModelEvent(ModelEventType.error, error_message="The provider returned an invalid or incomplete stream."),
    ]


async def test_chat_usage_trailer_seen_before_connection_loss_prevents_call_execution() -> None:
    fragment = {"index": 0, "id": "call_1", "function": {"name": "lookup", "arguments": "{}"}}

    class BrokenStream(httpx.AsyncByteStream):
        async def __aiter__(self) -> AsyncIterator[bytes]:
            yield sse(chunk({"tool_calls": [fragment]}, "tool_calls"))
            yield sse({"choices": [], "usage": {"prompt_tokens": 11, "completion_tokens": 6}})
            raise httpx.ReadError(SECRET)

    transport = httpx.MockTransport(lambda _: httpx.Response(200, stream=BrokenStream()))
    adapter = StreamingProvider(
        "omniroute", MODELS["omniroute"], "test-key", "https://provider.invalid", transport=transport
    )
    assert await collect(adapter, HISTORY) == [
        ModelEvent(ModelEventType.usage, input_tokens=11, output_tokens=6),
        ModelEvent(ModelEventType.error, error_message="The provider connection failed."),
    ]


@pytest.mark.parametrize("provider", ["groq", "openai"])
async def test_runner_can_record_usage_before_rejecting_duplicate_calls(provider: str) -> None:
    if provider == "openai":
        body = sse(completed([call_item("{}"), call_item("{}")], usage={"input_tokens": 9, "output_tokens": 2}))
    else:
        fragment = {"index": 0, "id": "call_1", "function": {"name": "lookup", "arguments": "{}"}}
        body = sse(
            chunk(
                {"tool_calls": [fragment, dict(fragment, index=1)]},
                "tool_calls",
                usage={"prompt_tokens": 9, "completion_tokens": 2},
            ),
            "[DONE]",
        )
    adapter, _ = scripted(provider, body)
    usage, first_call, duplicate, _ = await collect(adapter, HISTORY)
    assert usage == ModelEvent(ModelEventType.usage, input_tokens=9, output_tokens=2)
    assert first_call.type == duplicate.type == ModelEventType.tool_call
    assert first_call.call_id == duplicate.call_id == "call_1"
