import assert from "node:assert/strict";
import test from "node:test";
import { summarizeToolCall, summarizeToolResult } from "../../src/lib/tool-summaries.ts";

test("an order query reads like a sentence", () => {
  assert.equal(
    summarizeToolCall("query_orders", {
      min_amount_minor: 50000,
      late_only: true,
      status: "shipped",
      limit: 100,
      shipped_after: "2026-01-01T00:00:00+00:00",
      shipped_before: "2026-02-01T00:00:00+00:00",
    }),
    "Late orders over $500.00, shipped Jan 1 – Feb 1, 2026",
  );
  assert.equal(summarizeToolCall("query_orders", { sort_by: "id", limit: 100 }), "All orders, up to 100");
  assert.equal(
    summarizeToolCall("query_orders", { status: "partially_refunded", max_amount_minor: 10000, sort_by: "amount_minor", sort_order: "desc" }),
    "Partially refunded orders up to $100.00, by amount, highest first",
  );
  assert.equal(summarizeToolCall("query_orders", { shipped_after: "2026-01-01T00:00:00Z" }), "Orders, shipped since Jan 1, 2026");
});

test("date math, policy search and refund calls have their own summaries", () => {
  assert.equal(summarizeToolCall("date_math", { operation: "previous_month", reference_date: "2026-02-15" }), "Previous calendar month before Feb 15, 2026");
  assert.equal(summarizeToolCall("date_math", { operation: "days_between", start_date: "2026-01-01", end_date: "2026-01-06" }), "Days from Jan 1, 2026 to Jan 6, 2026");
  assert.equal(summarizeToolCall("date_math", { operation: "add_days", reference_date: "2026-02-15", days: -3 }), "Feb 15, 2026 minus 3 days");
  assert.equal(summarizeToolCall("search_policies", { query: "EMAIL-01" }), 'Search policies for "EMAIL-01"');
  assert.equal(summarizeToolCall("issue_refund", { order_id: "ORD-1006", reason: "Late shipment" }), "Refund ORD-1006: Late shipment");
});

test("unknown tools fall back to key: value pairs", () => {
  assert.equal(summarizeToolCall("lookup_weather", { city: "Dhaka", days: 3, nested: { a: 1 } }), "city: Dhaka, days: 3");
  assert.equal(summarizeToolCall("lookup_weather", {}), "No arguments");
});

test("results summarize what came back", () => {
  const ok = (data: unknown) => ({ kind: "success" as const, data });
  assert.equal(summarizeToolResult("query_orders", ok({ orders: [], count: 10 })), "10 orders");
  assert.equal(summarizeToolResult("query_orders", ok({ orders: [], count: 0 })), "No matching orders");
  assert.equal(summarizeToolResult("search_policies", ok({ matches: [{ id: "EMAIL-01" }] })), "1 policy");
  assert.equal(summarizeToolResult("search_policies", ok({ matches: [] })), "No matching policies");
  assert.equal(
    summarizeToolResult("date_math", ok({ operation: "previous_month", reference_date: "2026-02-15", start: "2026-01-01", end: "2026-02-01" })),
    "Jan 1 – Feb 1, 2026",
  );
  assert.equal(summarizeToolResult("issue_refund", ok({ order_id: "ORD-1006", amount_minor: 8451, currency: "USD" })), "$84.51 USD recorded");
  assert.equal(summarizeToolResult("issue_refund", ok({ order_id: "ORD-1006", amount_minor: 8451, already_issued: true })), "$84.51 USD already recorded");
  assert.equal(summarizeToolResult("query_orders", { kind: "failure", code: "TOOL_ERROR", message: "x" }), null);
  assert.equal(summarizeToolResult("lookup_weather", ok({})), null);
});
