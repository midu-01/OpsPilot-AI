import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ApiError, checkReadiness, createRun, getApiBaseUrl, getStreamUrl } from "../../src/lib/api.ts";

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

  assert.equal(getStreamUrl("run-id", 12), "http://127.0.0.1:13000/api/runs/run-id/stream?after=12");
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

test("an explicit API base retains its path prefix", async (t) => {
  browserAt(t, "http://localhost:3000");
  process.env.NEXT_PUBLIC_API_BASE_URL = "https://api.example.test/v1";
  let requestedUrl = "";
  t.mock.method(globalThis, "fetch", async (url: string) => {
    requestedUrl = String(url);
    return Response.json({ id: "created", status: "queued" }, { status: 202 });
  });

  await createRun("Configured endpoint");
  assert.equal(requestedUrl, "https://api.example.test/v1/runs");
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
