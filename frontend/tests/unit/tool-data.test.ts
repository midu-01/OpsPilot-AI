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

test("policy matches say why they matched, and the result says how it searched", () => {
  const data = parsePolicySearchData({
    query: "late shipment refund",
    matches: [
      {
        id: "LATE-01",
        title: "Late shipment eligibility",
        version: "v1",
        file: "02-late-shipment-eligibility.md",
        excerpt: "An order is late when it ships after the promised date.",
        relevance_score: 0.0328,
        matched_by: ["keyword", "semantic"],
        similarity: 0.71,
      },
      { id: "EMAIL-01", title: "Email drafts", matched_by: ["id"], similarity: null },
    ],
    total_policies: 8,
    search: { mode: "hybrid", embedding_model: "test-model" },
  });
  assert.deepEqual(
    data?.matches.map((match) => [match.id, match.matchedBy, match.similarity]),
    [
      ["LATE-01", ["keyword", "semantic"], 0.71],
      ["EMAIL-01", ["id"], null],
    ],
  );
  assert.equal(data?.searchMode, "hybrid");
  assert.equal(parsePolicySearchData({ matches: [], search: { mode: "keyword" } })?.searchMode, "keyword");
});

test("policy results saved before hybrid search parse without reasons, similarity or mode", () => {
  const data = parsePolicySearchData({
    query: "EMAIL-01",
    matches: [{ id: "EMAIL-01", title: "Email drafts", version: "v1", file: "07-email-drafts.md", excerpt: "Drafts only.", relevance_score: 7 }],
    total_policies: 8,
  });
  assert.deepEqual(data, {
    query: "EMAIL-01",
    matches: [
      { id: "EMAIL-01", title: "Email drafts", version: "v1", file: "07-email-drafts.md", excerpt: "Drafts only.", matchedBy: [], similarity: null },
    ],
    totalPolicies: 8,
    message: null,
    searchMode: null,
  });
});

test("match reasons, similarity and search mode are read defensively", () => {
  const firstMatch = (fields: Record<string, unknown>) => parsePolicySearchData({ matches: [{ id: "LATE-01", ...fields }] })?.matches[0];

  // Unknown reasons are dropped, repeats collapse, and the order is always id, keyword, semantic.
  assert.deepEqual(firstMatch({ matched_by: ["semantic", "vibes", 3, "id", "semantic"] })?.matchedBy, ["id", "semantic"]);
  assert.deepEqual(firstMatch({ matched_by: "keyword" })?.matchedBy, []);
  assert.deepEqual(firstMatch({ matched_by: null })?.matchedBy, []);

  // A similarity is shown as a percentage, so only numbers from 0 to 1 are kept.
  assert.equal(firstMatch({ similarity: 0 })?.similarity, 0);
  assert.equal(firstMatch({ similarity: 1 })?.similarity, 1);
  for (const similarity of ["0.7", 1.5, -0.2, null, undefined]) {
    assert.equal(firstMatch({ similarity })?.similarity, null, `similarity ${String(similarity)}`);
  }

  // An unknown or malformed search mode is treated as unknown.
  for (const search of [{ mode: "vector" }, { mode: null }, {}, "hybrid", null, undefined]) {
    assert.equal(parsePolicySearchData({ matches: [], search })?.searchMode, null, `search ${JSON.stringify(search)}`);
  }
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
