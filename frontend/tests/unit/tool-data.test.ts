import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDateMathData,
  parseOrdersData,
  parsePolicySearchData,
  parseRefundReceipt,
  parseToolResult,
} from "../../src/lib/tool-data.ts";

test("tool results are narrowed whether they arrive as objects or JSON strings", () => {
  assert.deepEqual(parseToolResult(null), { kind: "none" });
  assert.deepEqual(parseToolResult({ ok: true, data: { count: 1 } }), { kind: "success", data: { count: 1 } });
  assert.deepEqual(parseToolResult('{"ok":true,"data":[1]}'), { kind: "success", data: [1] });
  assert.deepEqual(parseToolResult({ ok: false, error: { code: "TOOL_ERROR", message: "Boom" } }), {
    kind: "failure",
    code: "TOOL_ERROR",
    message: "Boom",
  });
  assert.deepEqual(parseToolResult({ ok: false }), { kind: "failure", code: "TOOL_ERROR", message: "The tool call failed." });
  assert.deepEqual(parseToolResult("plain text"), { kind: "text", text: "plain text" });
  assert.deepEqual(parseToolResult({ unexpected: true }), { kind: "text", text: '{\n  "unexpected": true\n}' });
});

test("order rows are read defensively and malformed rows are dropped", () => {
  const data = parseOrdersData({
    orders: [
      {
        id: "ORD-1006",
        customer_name: "Demo Customer 06",
        customer_email: "customer06@example.test",
        amount_minor: 84505,
        currency: "USD",
        status: "shipped",
        promised_ship_at: "2026-01-03T12:00:00+00:00",
        shipped_at: "2026-01-06T12:00:00+00:00",
      },
      { customer_name: "No id" },
      "not an object",
    ],
    count: 1,
    offset: 0,
    limit: 100,
  });
  assert.equal(data?.orders.length, 1);
  assert.equal(data?.orders[0].amountMinor, 84505);
  assert.equal(data?.limit, 100);
  assert.equal(parseOrdersData({ orders: "nope" }), null);
  assert.equal(parseOrdersData(null), null);
});

test("policy matches keep id, title, version and excerpt", () => {
  const data = parsePolicySearchData({
    query: "EMAIL-01",
    matches: [{ id: "EMAIL-01", title: "Email drafts", version: "v1", file: "07-email-drafts.md", excerpt: "Drafts only." }, { title: "no id" }],
    total_policies: 8,
  });
  assert.deepEqual(data?.matches.map((m) => m.id), ["EMAIL-01"]);
  assert.equal(data?.totalPolicies, 8);
  assert.equal(data?.message, null);
  assert.equal(parsePolicySearchData({ query: "x", matches: [], message: "No policies matched the search terms." })?.message,
    "No policies matched the search terms.");
  assert.equal(parsePolicySearchData({}), null);
});

test("date math results are read per operation", () => {
  assert.equal(
    parseDateMathData({ operation: "previous_month", reference_date: "2026-02-15", start: "2026-01-01", end: "2026-02-01", days_in_month: 31 })?.operation,
    "previous_month",
  );
  assert.deepEqual(parseDateMathData({ operation: "days_between", start_date: "2026-01-01", end_date: "2026-01-06", days: 5 }), {
    operation: "days_between",
    startDate: "2026-01-01",
    endDate: "2026-01-06",
    days: 5,
  });
  assert.equal(parseDateMathData({ operation: "add_days", reference_date: "2026-02-15", days: 7, result: "2026-02-22" })?.operation, "add_days");
  assert.equal(parseDateMathData({ operation: "previous_month" }), null);
  assert.equal(parseDateMathData({ operation: "unknown" }), null);
});

test("a refund receipt needs an order or refund id", () => {
  const receipt = parseRefundReceipt({
    simulated: true,
    refund_id: "r-1",
    order_id: "ORD-1006",
    amount_minor: 8451,
    currency: "USD",
    policy_version: "v1",
    already_issued: false,
  });
  assert.equal(receipt?.amountMinor, 8451);
  assert.equal(receipt?.alreadyIssued, false);
  assert.equal(parseRefundReceipt({ amount_minor: 1 }), null);
});
