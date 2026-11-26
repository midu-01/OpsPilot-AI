import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseStreamMessage, readRunSocket, StreamClosedError, type StreamMessage } from "../../src/lib/run-stream.ts";
import type { RunEvent } from "../../src/lib/api.ts";
import { FakeSocket } from "./fixtures/fake-socket.ts";

const event: RunEvent = {
  schema_version: 1, run_id: "run-123", sequence: 2, type: "message.delta",
  occurred_at: "2026-02-15T12:00:00Z", payload: { message_id: "message-1", delta: "Hello বাংলা" },
};

async function collect(reader: AsyncGenerator<StreamMessage>): Promise<StreamMessage[]> {
  const messages: StreamMessage[] = [];
  for await (const message of reader) messages.push(message);
  return messages;
}

function read(socket: FakeSocket, options: { signal?: AbortSignal; idleTimeoutMs?: number } = {}) {
  return readRunSocket(socket.asWebSocket(), { signal: options.signal ?? new AbortController().signal, idleTimeoutMs: options.idleTimeoutMs });
}

test("a text frame is a run event or one of the two control messages, and UTF-8 text survives", () => {
  assert.deepEqual(parseStreamMessage(JSON.stringify(event)), event);
  assert.deepEqual(parseStreamMessage('{"type":"stream.ready"}'), { type: "stream.ready" });
  assert.deepEqual(parseStreamMessage('{"type":"stream.keepalive","extra":1}'), { type: "stream.keepalive" });
});

test("a malformed, binary or invalid message throws, so the loop recovers instead of losing output", () => {
  const invalid: unknown[] = [
    "not json", "null", "5", "[]", new ArrayBuffer(4),
    JSON.stringify({ ...event, schema_version: 2 }),
    JSON.stringify({ ...event, sequence: 0 }),
    JSON.stringify({ ...event, sequence: 1.5 }),
    JSON.stringify({ ...event, type: "stream.unknown" }),
    JSON.stringify({ ...event, payload: [] }),
    JSON.stringify({ ...event, occurred_at: "yesterday" }),
  ];
  for (const data of invalid) {
    assert.throws(() => parseStreamMessage(data), /binary|malformed|invalid/, String(data));
  }
});

test("the reader yields messages in order and ends when the server closes with 1000", async () => {
  const socket = new FakeSocket();
  const reading = collect(read(socket));
  // All of these arrive before the reader handles the first: they wait in order.
  socket.open();
  socket.serverSends({ type: "stream.ready" });
  socket.serverSends(event);
  socket.serverSends({ type: "stream.keepalive" });
  socket.serverCloses(1000, "Run finished");

  assert.deepEqual(await reading, [{ type: "stream.ready" }, event, { type: "stream.keepalive" }]);
  assert.equal(socket.closeCalls, 0); // already closed by the server
});

test("any other close code throws a StreamClosedError that carries it", async () => {
  for (const [code, reason] of [[4401, "Not authenticated"], [4422, "Cursor is ahead of the run's latest sequence"], [1006, ""]] as const) {
    const socket = new FakeSocket();
    const reading = collect(read(socket));
    socket.serverCloses(code, reason);
    await assert.rejects(reading, (error: unknown) => {
      assert.ok(error instanceof StreamClosedError);
      assert.equal(error.code, code);
      assert.match(error.message, new RegExp(`code ${code}`));
      return true;
    });
  }
});

test("silence longer than the idle timeout closes the socket and throws", async () => {
  const socket = new FakeSocket();
  const reading = collect(read(socket, { idleTimeoutMs: 20 }));
  socket.open();
  socket.serverSends({ type: "stream.ready" });
  await assert.rejects(reading, /went quiet/);
  assert.equal(socket.closeCalls, 1);
});

test("keepalives keep a quiet run's stream open", async () => {
  const socket = new FakeSocket();
  const reading = collect(read(socket, { idleTimeoutMs: 100 }));
  socket.open();
  for (let i = 0; i < 4; i++) {
    await delay(40); // 160 ms in all, longer than the timeout, but never 100 ms without a message
    socket.serverSends({ type: "stream.keepalive" });
  }
  socket.serverCloses(1000);
  assert.equal((await reading).length, 4);
});

test("aborting stops the reader with the signal's reason and closes the socket", async () => {
  const controller = new AbortController();
  const socket = new FakeSocket();
  const reading = collect(read(socket, { signal: controller.signal }));
  socket.open();
  socket.serverSends({ type: "stream.ready" });
  controller.abort();
  await assert.rejects(reading, { name: "AbortError" });
  assert.equal(socket.closeCalls, 1);
});

test("leaving the loop early closes the socket", async () => {
  const socket = new FakeSocket();
  const reader = read(socket);
  const first = reader.next();
  socket.open();
  socket.serverSends({ type: "stream.ready" });
  assert.deepEqual((await first).value, { type: "stream.ready" });

  await reader.return(undefined);
  assert.equal(socket.closeCalls, 1);
});
