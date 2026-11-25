import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { NextRequest } from "next/server.js";
import { GET, POST } from "../../src/app/api/[...path]/route.ts";

const RUN_ID = "01234567-89ab-4cde-8fab-0123456789ab";
const TOKEN = "q3J6bF9xV0t1d2pQbm5LZ2J6U0lGZk1fQ3pYc0dRbE0";
const COOKIE = `opspilot_session=${TOKEN}`;

function internalApi(t: TestContext) {
  const originalBase = process.env.API_INTERNAL_URL;
  process.env.API_INTERNAL_URL = "http://backend:8000";
  t.after(() => {
    if (originalBase === undefined) delete process.env.API_INTERNAL_URL;
    else process.env.API_INTERNAL_URL = originalBase;
  });
}

const runsRoute = { params: Promise.resolve({ path: ["runs"] }) };

test("the registered Next.js route forwards a run POST and GET snapshot with the session's token", async (t) => {
  internalApi(t);
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    requests.push(`${options.method} ${url} ${new Headers(options.headers).get("authorization")}`);
    return Response.json({ id: RUN_ID, status: "queued" }, { status: options.method === "POST" ? 202 : 200 });
  });

  const created = await POST(new NextRequest("http://console:3000/api/runs", {
    method: "POST", headers: { "Content-Type": "application/json", cookie: `theme=dark; ${COOKIE}` }, body: '{"goal":"Check shipments"}',
  }), runsRoute);
  assert.equal(created.status, 202);
  assert.equal((await created.json()).id, RUN_ID);

  const snapshot = await GET(new NextRequest(`http://console:3000/api/runs/${RUN_ID}`, { headers: { cookie: COOKIE } }), {
    params: Promise.resolve({ path: ["runs", RUN_ID] }),
  });
  assert.equal(snapshot.status, 200);
  assert.deepEqual(requests, [
    `POST http://backend:8000/runs Bearer ${TOKEN}`,
    `GET http://backend:8000/runs/${RUN_ID} Bearer ${TOKEN}`,
  ]);
});

test("the registered route answers 401 to a browser without a session", async (t) => {
  internalApi(t);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({}));
  const response = await GET(new NextRequest("http://console:3000/api/runs"), runsRoute);
  assert.equal(response.status, 401);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("a session cookie that is not token-shaped counts as no session", async (t) => {
  internalApi(t);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({}));
  for (const cookie of ["opspilot_session=", "opspilot_session=short", "opspilot_session=has%20space%20and%20is%20long%20enough", `other_session=${TOKEN}`]) {
    const response = await GET(new NextRequest("http://console:3000/api/runs", { headers: { cookie } }), runsRoute);
    assert.equal(response.status, 401, cookie);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});
