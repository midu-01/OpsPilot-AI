import assert from "node:assert/strict";
import test from "node:test";
import { readRunEvents } from "../../src/lib/run-stream.ts";
import type { RunEvent } from "../../src/lib/api.ts";

const event: RunEvent = {
  schema_version: 1, run_id: "run-123", sequence: 2, type: "message.delta",
  occurred_at: "2026-02-15T12:00:00Z", payload: { message_id: "message-1", delta: "Hello বাংলা" },
};

function framed(value: RunEvent): string {
  return `id: ${value.sequence}\r\nevent: ${value.type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
}

function response(chunks: Uint8Array[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

test("a complete SSE event survives every network chunk split, including UTF-8 text", async () => {
  const data = new TextEncoder().encode(framed(event));
  for (let split = 1; split < data.length; split++) {
    const received = [];
    for await (const value of readRunEvents(response([data.slice(0, split), data.slice(split)]))) received.push(value);
    assert.deepEqual(received, [event], `Lost or duplicated frame at byte ${split}`);
  }
});

test("heartbeats do not consume events and terminal frames arrive after deltas", async () => {
  const terminal = { ...event, sequence: 3, type: "run.completed" as const, payload: { status: "completed" } };
  const data = new TextEncoder().encode(`: keepalive\n\n${framed(event)}: keepalive\n\n${framed(terminal)}`);
  const received = [];
  for await (const value of readRunEvents(response([data]))) received.push(value);
  assert.deepEqual(received.map(value => value.sequence), [2, 3]);
});

test("a malformed complete frame triggers recovery rather than silently losing output", async () => {
  const data = new TextEncoder().encode('id: 2\nevent: message.delta\ndata: not-json\n\n');
  await assert.rejects(async () => {
    for await (const _ of readRunEvents(response([data]))) { /* consume */ }
  }, /invalid|malformed/i);
});

test("closing the reader cancels only its response stream", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(framed(event))); },
    cancel() { cancelled = true; },
  });
  const reader = readRunEvents(new Response(stream, { headers: { "Content-Type": "text/event-stream" } }));
  assert.equal((await reader.next()).value?.sequence, 2);
  await reader.return(undefined);
  assert.equal(cancelled, true);
});
