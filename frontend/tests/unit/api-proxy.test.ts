import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { forwardApiRequest } from "../../src/lib/api-proxy.ts";

const RUN_ID = "01234567-89ab-4cde-8fab-0123456789ab";

function internalApi(t: TestContext) {
  const original = process.env.API_INTERNAL_URL;
  process.env.API_INTERNAL_URL = "http://backend:8000";
  t.after(() => {
    if (original === undefined) delete process.env.API_INTERNAL_URL;
    else process.env.API_INTERNAL_URL = original;
  });
}

test("the proxy forwards goal creation to the configured internal API", async (t) => {
  internalApi(t);
  let forwardedUrl = "";
  let forwardedBody = "";
  let forwardedHeaders = new Headers();
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    forwardedUrl = String(url);
    forwardedBody = String(options.body);
    forwardedHeaders = new Headers(options.headers);
    return Response.json({ id: RUN_ID, status: "queued" }, { status: 202 });
  });

  const response = await forwardApiRequest(new Request("http://frontend:3000/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json", "cookie": "private-cookie", "authorization": "private-token" },
    body: JSON.stringify({ goal: "Find delayed orders." }),
  }), ["runs"]);

  assert.equal(forwardedUrl, "http://backend:8000/runs");
  assert.deepEqual(JSON.parse(forwardedBody), { goal: "Find delayed orders." });
  assert.equal(forwardedHeaders.get("content-type"), "application/json");
  assert.equal(forwardedHeaders.get("authorization"), null);
  assert.equal(forwardedHeaders.get("cookie"), null);
  assert.equal(response.status, 202);
  assert.equal((await response.json()).id, RUN_ID);
});

test("SSE frames pass through incrementally with replay cursors", async (t) => {
  internalApi(t);
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const upstream = new ReadableStream<Uint8Array>({
    start(stream) {
      controller = stream;
      stream.enqueue(encoder.encode('id: 12\nevent: message.delta\ndata: {"sequence":12}\n\n'));
    },
  });
  let sentUrl = "";
  let sentCursor = "";
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    sentUrl = String(url);
    sentCursor = new Headers(options.headers).get("Last-Event-ID") || "";
    return new Response(upstream, { headers: { "content-type": "text/event-stream" } });
  });

  const timeout = setTimeout(() => controller.error(new Error("SSE was buffered")), 1000);
  t.after(() => clearTimeout(timeout));
  const response = await forwardApiRequest(new Request(`http://frontend:3000/api/runs/${RUN_ID}/stream?after=11`, {
    headers: { "Last-Event-ID": "11" },
  }), ["runs", RUN_ID, "stream"]);
  assert.equal(response.status, 200);
  assert.ok(response.body, "The proxy must return the incremental response body");
  const reader = response.body.getReader();

  assert.equal(sentUrl, `http://backend:8000/runs/${RUN_ID}/stream?after=11`);
  assert.equal(sentCursor, "11");
  assert.match(response.headers.get("content-type")!, /text\/event-stream/);
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  assert.match(new TextDecoder().decode((await reader.read()).value), /id: 12\nevent: message.delta/);

  controller!.enqueue(encoder.encode('id: 13\nevent: run.completed\ndata: {"sequence":13}\n\n'));
  controller!.close();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: run.completed/);
  assert.equal((await reader.read()).done, true);
});

for (const status of [204, 404, 409, 422, 500]) {
  test(`backend status ${status} is preserved`, async (t) => {
    internalApi(t);
    t.mock.method(globalThis, "fetch", async () => new Response(status === 204 ? null : "Backend response", {
      status,
      headers: { "content-type": "text/plain" },
    }));

    const response = await forwardApiRequest(new Request(`http://frontend:3000/api/runs/${RUN_ID}`), ["runs", RUN_ID]);
    assert.equal(response.status, status);
    assert.equal(await response.text(), status === 204 ? "" : "Backend response");
  });
}

test("an unreachable backend becomes a safe actionable 502 response", async (t) => {
  internalApi(t);
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("internal diagnostic and secret");
  });

  const response = await forwardApiRequest(new Request("http://frontend:3000/api/health/ready"), ["health", "ready"]);
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.match(body.detail, /backend.*running/i);
  assert.doesNotMatch(JSON.stringify(body), /internal diagnostic|secret/);
});

test("the proxy does not forward arbitrary or traversal paths", async (t) => {
  internalApi(t);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("must not be called"); });
  for (const path of [["admin"], ["runs", "..", "health"], ["health", "unknown"]]) {
    const response = await forwardApiRequest(new Request("http://frontend:3000/api/unknown"), path);
    assert.equal(response.status, 404);
  }
});
