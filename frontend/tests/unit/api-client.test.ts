import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ApiError, checkReadiness, createRun, getApiBaseUrl, getMe, getRun, getStreamUrl, listRuns, login, logout } from "../../src/lib/api.ts";

function browserAt(t: TestContext, origin: string) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousBase = process.env.NEXT_PUBLIC_API_BASE_URL;
  delete process.env.NEXT_PUBLIC_API_BASE_URL;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: new URL(origin) },
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousBase === undefined) delete process.env.NEXT_PUBLIC_API_BASE_URL;
    else process.env.NEXT_PUBLIC_API_BASE_URL = previousBase;
  });
}

for (const origin of ["http://localhost:3000", "http://127.0.0.1:13000", "https://console.example.test"]) {
  test(`goal submission stays on the frontend origin ${origin}`, async (t) => {
    browserAt(t, origin);
    let sentUrl = "";
    let sentBody = "";
    t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
      sentUrl = String(url);
      sentBody = String(options.body);
      return Response.json({ id: "run-created", status: "queued" }, { status: 202 });
    });

    const run = await createRun("Find late orders and draft emails.");

    assert.equal(sentUrl, `${origin}/api/runs`);
    assert.deepEqual(JSON.parse(sentBody), { goal: "Find late orders and draft emails." });
    assert.equal(run.id, "run-created");
  });
}

test("stream replay and browser readiness use the same API prefix", async (t) => {
  browserAt(t, "http://127.0.0.1:13000");
  let requestedUrl = "";
  t.mock.method(globalThis, "fetch", async (url: string) => {
    requestedUrl = String(url);
    return Response.json({ status: "ready", details: { database: "connected" } });
  });

  const runId = "01234567-89ab-4cde-8fab-0123456789ab";
  assert.equal(getStreamUrl(runId, 12), `http://127.0.0.1:13000/api/runs/${runId}/stream?after=12`);
  assert.equal(await checkReadiness(getApiBaseUrl()), true);
  assert.equal(requestedUrl, "http://127.0.0.1:13000/api/health/ready");
});

test("network errors keep an actionable message instead of replacing it with Failed to fetch", async (t) => {
  browserAt(t, "http://localhost:3000");
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("Failed to fetch");
  });

  await assert.rejects(createRun("Keep this draft"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 0);
    assert.match(error.detail || error.message, /backend.*running/i);
    assert.notEqual(error.detail || error.message, "Failed to fetch");
    return true;
  });
});

test("non-JSON backend errors retain their HTTP status and readable explanation", async (t) => {
  browserAt(t, "http://localhost:3000");
  t.mock.method(globalThis, "fetch", async () => new Response("Internal Server Error", { status: 500 }));

  await assert.rejects(createRun("Keep this draft"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 500);
    assert.equal(error.detail, "Internal Server Error");
    return true;
  });
});

test("the browser always uses the same-origin /api proxy, even with NEXT_PUBLIC_API_BASE_URL set", async (t) => {
  // Only the proxy turns the HttpOnly session cookie into a bearer token; a direct call would get 401.
  browserAt(t, "http://localhost:3000");
  process.env.NEXT_PUBLIC_API_BASE_URL = "https://api.example.test/v1";
  let requestedUrl = "";
  t.mock.method(globalThis, "fetch", async (url: string) => {
    requestedUrl = String(url);
    return Response.json({ id: "created", status: "queued" }, { status: 202 });
  });

  await createRun("Configured endpoint");
  assert.equal(requestedUrl, "http://localhost:3000/api/runs");
  assert.equal(getStreamUrl("01234567-89ab-4cde-8fab-0123456789ab"), "http://localhost:3000/api/runs/01234567-89ab-4cde-8fab-0123456789ab/stream");
});

test("explicit request cancellation remains an AbortError", async (t) => {
  browserAt(t, "http://localhost:3000");
  const controller = new AbortController();
  controller.abort();
  t.mock.method(globalThis, "fetch", async () => {
    throw new DOMException("The request was aborted", "AbortError");
  });

  await assert.rejects(createRun("Cancelled request", { signal: controller.signal }), { name: "AbortError" });
});

test("a run ID that is not a UUID is rejected before any request", async (t) => {
  browserAt(t, "http://localhost:3000");
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({}));
  for (const id of ["..", ".", "../health/ready", "not-a-uuid"]) {
    await assert.rejects(getRun(id), (error: unknown) => error instanceof ApiError && error.status === 422);
    assert.throws(() => getStreamUrl(id), (error: unknown) => error instanceof ApiError && error.status === 422);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("a body that is not JSON, or a snapshot missing its trace, becomes a 502 ApiError", async (t) => {
  browserAt(t, "http://localhost:3000");
  const runId = "01234567-89ab-4cde-8fab-0123456789ab";
  t.mock.method(globalThis, "fetch", async () => new Response("<html>", { status: 200 }));
  await assert.rejects(getRun(runId), (error: unknown) => error instanceof ApiError && error.status === 502);
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => Response.json({ id: runId, messages: [] }));
  await assert.rejects(getRun(runId), (error: unknown) => error instanceof ApiError && error.status === 502);
});

function internalApi(t: TestContext) {
  const original = process.env.API_INTERNAL_URL;
  process.env.API_INTERNAL_URL = "http://backend:8000";
  t.after(() => {
    if (original === undefined) delete process.env.API_INTERNAL_URL;
    else process.env.API_INTERNAL_URL = original;
  });
}

const USER = { id: "5f0c7a52-3f7e-4d55-9a43-7f1d2c3b4a5e", email: "alex@opspilot.test", display_name: "Alex Rivera" };

test("server loaders can pass the session's Authorization header to the backend", async (t) => {
  internalApi(t);
  const runId = "01234567-89ab-4cde-8fab-0123456789ab";
  const sent: { url: string; authorization: string | null }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    sent.push({ url: String(url), authorization: new Headers(options.headers).get("authorization") });
    if (String(url).includes("/runs/")) return Response.json({ id: runId, messages: [], events: [], snapshot_cursor: 0 });
    return Response.json({ items: [], total: 0, page: 1, page_size: 20 });
  });

  await getRun(runId, { headers: { Authorization: "Bearer token-1" } });
  await listRuns(2, 20, { headers: { Authorization: "Bearer token-2" } });

  assert.deepEqual(sent, [
    { url: `http://backend:8000/runs/${runId}`, authorization: "Bearer token-1" },
    { url: "http://backend:8000/runs?page=2&page_size=20", authorization: "Bearer token-2" },
  ]);
});

test("a 401 from the backend stays an ApiError with its status", async (t) => {
  internalApi(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ detail: "Not authenticated" }, { status: 401 }));
  await assert.rejects(listRuns(), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    assert.equal(error.detail, "Not authenticated");
    return true;
  });
});

test("login posts the credentials to the backend and checks the session it returns", async (t) => {
  internalApi(t);
  let sentUrl = "";
  let sentBody: unknown = null;
  const session = { access_token: "tok_abcdefghijklmnopqrstuvwxyz", token_type: "bearer", expires_at: "2026-11-25T22:00:00Z", user: USER };
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    sentUrl = String(url);
    sentBody = JSON.parse(String(options.body));
    return Response.json(session);
  });

  assert.deepEqual(await login("alex@opspilot.test", "secret"), session);
  assert.equal(sentUrl, "http://backend:8000/auth/login");
  assert.deepEqual(sentBody, { email: "alex@opspilot.test", password: "secret" });
});

test("login rejects a wrong password as a 401 and an odd session as a 502", async (t) => {
  internalApi(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ detail: "Invalid email or password" }, { status: 401 }));
  await assert.rejects(login("alex@opspilot.test", "wrong"), (error: unknown) => error instanceof ApiError && error.status === 401);
  t.mock.restoreAll();
  const token = "tok_abcdefghijklmnopqrstuvwxyz";
  const odd = [
    {},
    { access_token: "", expires_at: "2026-11-25T22:00:00Z", user: USER },
    { access_token: "not a token; Path=/", expires_at: "2026-11-25T22:00:00Z", user: USER },
    { access_token: token, expires_at: "soon", user: USER },
    { access_token: token, expires_at: "2026-11-25T22:00:00Z", user: { id: 1 } },
  ];
  for (const body of odd) {
    t.mock.method(globalThis, "fetch", async () => Response.json(body));
    await assert.rejects(login("alex@opspilot.test", "secret"), (error: unknown) => error instanceof ApiError && error.status === 502);
    t.mock.restoreAll();
  }
});

test("getMe returns the signed-in user and refuses a body that is not one", async (t) => {
  internalApi(t);
  let authorization: string | null = null;
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    authorization = new Headers(options.headers).get("authorization");
    return Response.json(USER);
  });
  assert.deepEqual(await getMe({ headers: { Authorization: "Bearer t" } }), USER);
  assert.equal(authorization, "Bearer t");
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => Response.json({ id: USER.id }));
  await assert.rejects(getMe(), (error: unknown) => error instanceof ApiError && error.status === 502);
});

test("logout accepts the backend's empty 204 answer", async (t) => {
  internalApi(t);
  let request = "";
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    request = `${options.method} ${url} ${new Headers(options.headers).get("authorization")}`;
    return new Response(null, { status: 204 });
  });
  assert.equal(await logout({ headers: { Authorization: "Bearer t" } }), undefined);
  assert.equal(request, "POST http://backend:8000/auth/logout Bearer t");
});
