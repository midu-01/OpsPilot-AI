import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { isRunStreamPath, routeRunStream } from "../../src/lib/stream-proxy.ts";

const RUN_ID = "01234567-89ab-4cde-8fab-0123456789ab";
const TOKEN = "q3J6bF9xV0t1d2pQbm5LZ2J6U0lGZk1fQ3pYc0dRbE0";

function internalApi(t: TestContext) {
  const original = process.env.API_INTERNAL_URL;
  process.env.API_INTERNAL_URL = "http://backend:8000";
  t.after(() => {
    if (original === undefined) delete process.env.API_INTERNAL_URL;
    else process.env.API_INTERNAL_URL = original;
  });
}

/** A browser's handshake for the stream, as proxy.ts receives it. */
function handshake(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://console:3000${path}`, {
    headers: {
      host: "console:3000",
      origin: "http://console:3000",
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
      "sec-websocket-extensions": "permessage-deflate; client_max_window_bits",
      cookie: `theme=dark; opspilot_session=${TOKEN}`,
      "user-agent": "Mozilla/5.0",
      ...headers,
    },
  });
}

test("a same-origin handshake goes to FastAPI with the session as a bearer token and only the handshake headers", (t) => {
  internalApi(t);
  const route = routeRunStream(handshake(`/api/runs/${RUN_ID}/stream?after=12`), TOKEN);

  assert.equal(route.action, "forward");
  if (route.action !== "forward") return;
  assert.equal(route.target.href, `http://backend:8000/runs/${RUN_ID}/stream?after=12`);
  assert.deepEqual(Object.fromEntries(route.headers), {
    authorization: `Bearer ${TOKEN}`,
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    "sec-websocket-version": "13",
    "sec-websocket-extensions": "permessage-deflate; client_max_window_bits",
  }); // no cookie, origin or user-agent: the backend gets only what it needs
});

test("only the cursor reaches the backend's query string", (t) => {
  internalApi(t);
  const first = routeRunStream(handshake(`/api/runs/${RUN_ID}/stream`), TOKEN);
  const extra = routeRunStream(handshake(`/api/runs/${RUN_ID}/stream?after=7&debug=1`), TOKEN);
  assert.ok(first.action === "forward" && extra.action === "forward");
  assert.equal(first.target.search, "");
  assert.equal(extra.target.search, "?after=7");
});

test("inside a container the published host counts, not the bind address", (t) => {
  internalApi(t);
  const request = new Request(`http://0.0.0.0:3000/api/runs/${RUN_ID}/stream`, {
    headers: { ...Object.fromEntries(handshake("/").headers), host: "127.0.0.1:13000", origin: "http://127.0.0.1:13000" },
  });
  assert.equal(routeRunStream(request, TOKEN).action, "forward");
});

test("a handshake from another origin is refused (cross-site WebSocket hijacking)", (t) => {
  internalApi(t);
  for (const origin of ["https://evil.example", "http://console:3001", "null", "not a url"]) {
    const route = routeRunStream(handshake(`/api/runs/${RUN_ID}/stream`, { origin }), TOKEN);
    assert.equal(route.action, "refuse", origin);
  }
});

test("a handshake without a session is refused before it reaches the backend", (t) => {
  internalApi(t);
  assert.equal(routeRunStream(handshake(`/api/runs/${RUN_ID}/stream`), null).action, "refuse");
});

test("only a WebSocket handshake for a run's stream is forwarded", (t) => {
  internalApi(t);
  const plainGet = new Request(`http://console:3000/api/runs/${RUN_ID}/stream`, { headers: { host: "console:3000" } });
  assert.equal(routeRunStream(plainGet, TOKEN).action, "refuse"); // the /api route answers it with 426
  for (const path of ["/api/runs/not-a-uuid/stream", `/api/runs/${RUN_ID}`, `/api/runs/${RUN_ID}/stream/extra`, "/api/health/ready"]) {
    assert.equal(routeRunStream(handshake(path), TOKEN).action, "refuse", path);
  }
});

test("isRunStreamPath matches exactly the stream of one run", () => {
  assert.equal(isRunStreamPath(`/api/runs/${RUN_ID}/stream`), true);
  assert.equal(isRunStreamPath(`/api/runs/${RUN_ID.toUpperCase()}/stream`), true);
  for (const path of [`/api/runs/${RUN_ID}`, `/runs/${RUN_ID}/stream`, `/api/runs/${RUN_ID}/stream/`, "/api/runs/../stream"]) {
    assert.equal(isRunStreamPath(path), false, path);
  }
});
