import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST } from "../../src/app/api/[...path]/route.ts";

const RUN_ID = "01234567-89ab-4cde-8fab-0123456789ab";

test("the registered Next.js route forwards a run POST and GET snapshot", async (t) => {
  const originalBase = process.env.API_INTERNAL_URL;
  process.env.API_INTERNAL_URL = "http://backend:8000";
  t.after(() => {
    if (originalBase === undefined) delete process.env.API_INTERNAL_URL;
    else process.env.API_INTERNAL_URL = originalBase;
  });
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    requests.push(`${options.method} ${url}`);
    return Response.json({ id: RUN_ID, status: "queued" }, { status: options.method === "POST" ? 202 : 200 });
  });

  const created = await POST(new Request("http://console:3000/api/runs", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: '{"goal":"Check shipments"}',
  }), { params: Promise.resolve({ path: ["runs"] }) });
  assert.equal(created.status, 202);
  assert.equal((await created.json()).id, RUN_ID);

  const snapshot = await GET(new Request(`http://console:3000/api/runs/${RUN_ID}`), {
    params: Promise.resolve({ path: ["runs", RUN_ID] }),
  });
  assert.equal(snapshot.status, 200);
  assert.deepEqual(requests, [`POST http://backend:8000/runs`, `GET http://backend:8000/runs/${RUN_ID}`]);
});
