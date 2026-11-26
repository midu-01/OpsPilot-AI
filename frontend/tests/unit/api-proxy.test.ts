import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { forwardApiRequest } from "../../src/lib/api-proxy.ts";

const RUN_ID = "01234567-89ab-4cde-8fab-0123456789ab";
const TOKEN = "q3J6bF9xV0t1d2pQbm5LZ2J6U0lGZk1fQ3pYc0dRbE0";
const SESSION_COOKIE = `opspilot_session=${TOKEN}`;

/**
 * The route handler reads the session token from the cookie with Next's own parser and passes it
 * in (api-route.test.ts covers that step). TOKEN: a signed-in browser; null: no session.
 */
const signedIn = (url: string, init: RequestInit = {}) => new Request(url, init);

function internalApi(t: TestContext) {
  const original = process.env.API_INTERNAL_URL;
  process.env.API_INTERNAL_URL = "http://backend:8000";
  t.after(() => {
    if (original === undefined) delete process.env.API_INTERNAL_URL;
    else process.env.API_INTERNAL_URL = original;
  });
}

test("the proxy forwards goal creation with the session cookie as the bearer token", async (t) => {
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
    headers: { "content-type": "application/json", "cookie": `theme=dark; ${SESSION_COOKIE}`, "authorization": "Bearer client-supplied" },
    body: JSON.stringify({ goal: "Find delayed orders." }),
  }), ["runs"], TOKEN);

  assert.equal(forwardedUrl, "http://backend:8000/runs");
  assert.deepEqual(JSON.parse(forwardedBody), { goal: "Find delayed orders." });
  assert.equal(forwardedHeaders.get("content-type"), "application/json");
  // The browser's own Authorization is dropped; only the cookie's token goes upstream.
  assert.equal(forwardedHeaders.get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(forwardedHeaders.get("cookie"), null);
  assert.equal(response.status, 202);
  assert.equal((await response.json()).id, RUN_ID);
});

for (const status of [204, 404, 409, 422, 500]) {
  test(`backend status ${status} is preserved`, async (t) => {
    internalApi(t);
    t.mock.method(globalThis, "fetch", async () => new Response(status === 204 ? null : "Backend response", {
      status,
      headers: { "content-type": "text/plain" },
    }));

    const response = await forwardApiRequest(signedIn(`http://frontend:3000/api/runs/${RUN_ID}`), ["runs", RUN_ID], TOKEN);
    assert.equal(response.status, status);
    assert.equal(await response.text(), status === 204 ? "" : "Backend response");
  });
}

test("a plain GET of the run stream answers 426: it is a WebSocket, which proxy.ts forwards", async (t) => {
  internalApi(t);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({}));
  for (const token of [TOKEN, null]) {
    const response = await forwardApiRequest(signedIn(`http://console:3000/api/runs/${RUN_ID}/stream?after=3`), ["runs", RUN_ID, "stream"], token);
    assert.equal(response.status, 426);
    assert.equal(response.headers.get("upgrade"), "websocket");
    assert.match((await response.json()).detail, /WebSocket/);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("an unreachable backend becomes a safe actionable 502 response", async (t) => {
  internalApi(t);
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("internal diagnostic and secret");
  });

  const response = await forwardApiRequest(new Request("http://frontend:3000/api/health/ready"), ["health", "ready"], null);
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.match(body.detail, /backend.*running/i);
  assert.doesNotMatch(JSON.stringify(body), /internal diagnostic|secret/);
});

test("the proxy does not forward arbitrary or traversal paths", async (t) => {
  internalApi(t);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("must not be called"); });
  for (const path of [["admin"], ["runs", "..", "health"], ["health", "unknown"]]) {
    const response = await forwardApiRequest(new Request("http://frontend:3000/api/unknown"), path, null);
    assert.equal(response.status, 404);
  }
});

test("writes from another origin are refused before reaching the backend", async (t) => {
  internalApi(t);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({}));
  // A signed-in victim's browser would attach the cookie to a cross-site POST.
  const response = await forwardApiRequest(signedIn(`http://console:3000/api/runs/${RUN_ID}/stop`, {
    method: "POST",
    headers: { origin: "https://evil.example", host: "console:3000" },
  }), ["runs", RUN_ID, "stop"], TOKEN);
  assert.equal(response.status, 403);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("same-origin writes and requests without an Origin header are forwarded", async (t) => {
  internalApi(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ status: "cancelling" }));
  // Inside a container request.url is the bind address; the browser's Host is what counts.
  const sameOrigin = await forwardApiRequest(signedIn(`http://0.0.0.0:3000/api/runs/${RUN_ID}/stop`, {
    method: "POST",
    headers: { origin: "http://127.0.0.1:13000", host: "127.0.0.1:13000" },
  }), ["runs", RUN_ID, "stop"], TOKEN);
  const noOrigin = await forwardApiRequest(signedIn(`http://console:3000/api/runs/${RUN_ID}/stop`, { method: "POST" }), ["runs", RUN_ID, "stop"], TOKEN);
  assert.equal(sameOrigin.status, 200);
  assert.equal(noOrigin.status, 200);
});

test("oversized request bodies are refused", async (t) => {
  internalApi(t);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({}));
  const response = await forwardApiRequest(signedIn("http://console:3000/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal: "x".repeat(70_000) }),
  }), ["runs"], TOKEN);
  assert.equal(response.status, 413);
  assert.equal(fetchMock.mock.callCount(), 0);
});

for (const [method, path] of [
  ["GET", ["runs"]],
  ["POST", ["runs"]],
  ["GET", ["runs", RUN_ID]],
  ["POST", ["runs", RUN_ID, "approve"]],
  ["POST", ["runs", RUN_ID, "stop"]],
] as const) {
  test(`${method} /api/${path.join("/")} without a session answers 401 and never calls the backend`, async (t) => {
    internalApi(t);
    const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({}));
    const response = await forwardApiRequest(new Request(`http://console:3000/api/${path.join("/")}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: method === "POST" ? "{}" : undefined,
    }), [...path], null);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { detail: "Sign in to continue" });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(fetchMock.mock.callCount(), 0);
  });
}

test("health checks stay public and never carry the session token", async (t) => {
  internalApi(t);
  const sent: Array<string | null> = [];
  t.mock.method(globalThis, "fetch", async (_url: URL, options: RequestInit) => {
    sent.push(new Headers(options.headers).get("authorization"));
    return Response.json({ status: "ready", details: {} });
  });
  const anonymous = await forwardApiRequest(new Request("http://console:3000/api/health/ready"), ["health", "ready"], null);
  const withCookie = await forwardApiRequest(signedIn("http://console:3000/api/health/live", {
    headers: { authorization: "Bearer client-supplied" },
  }), ["health", "live"], TOKEN);
  assert.equal(anonymous.status, 200);
  assert.equal(withCookie.status, 200);
  assert.deepEqual(sent, [null, null]);
});

test("unknown paths stay 404 and cross-origin writes stay 403 whether or not a session exists", async (t) => {
  internalApi(t);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({}));
  const unknown = await forwardApiRequest(new Request("http://console:3000/api/auth/me"), ["auth", "me"], null);
  const crossSite = await forwardApiRequest(new Request("http://console:3000/api/runs", {
    method: "POST",
    headers: { origin: "https://evil.example", host: "console:3000" },
  }), ["runs"], null);
  assert.equal(unknown.status, 404);
  assert.equal(crossSite.status, 403);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("a backend 401 (expired or revoked session) is passed through to the browser", async (t) => {
  internalApi(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ detail: "Not authenticated" }, { status: 401 }));
  const response = await forwardApiRequest(signedIn(`http://console:3000/api/runs/${RUN_ID}`), ["runs", RUN_ID], TOKEN);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { detail: "Not authenticated" });
});
