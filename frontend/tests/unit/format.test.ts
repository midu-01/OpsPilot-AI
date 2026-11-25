import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCostUsd,
  formatCount,
  formatDate,
  formatDateRange,
  formatDateTime,
  formatDuration,
  formatMoneyMinor,
  formatMoneyWithCode,
  formatRelativeTime,
  formatTime,
  lateness,
  plural,
  truncate,
} from "../../src/lib/format.ts";
import { errorTitle } from "../../src/lib/error-codes.ts";

test("money is formatted from integer minor units", () => {
  assert.equal(formatMoneyMinor(8451), "$84.51");
  assert.equal(formatMoneyMinor(62500, "USD"), "$625.00");
  assert.equal(formatMoneyWithCode(8451, "USD"), "$84.51 USD");
  assert.equal(formatMoneyMinor(500, "JPY"), "¥500"); // zero-decimal currency
  assert.equal(formatMoneyMinor(1234, "??"), "12.34 ??"); // invalid currency code
});

test("cost estimates are decimal strings and unknown costs show a dash", () => {
  assert.equal(formatCostUsd(null), "—");
  assert.equal(formatCostUsd(undefined), "—");
  assert.equal(formatCostUsd("not a number"), "—");
  assert.equal(formatCostUsd("0"), "$0.00");
  assert.equal(formatCostUsd("0.0012345678"), "$0.0012");
  assert.equal(formatCostUsd("0.00001"), "<$0.0001");
  assert.equal(formatCostUsd("12.5"), "$12.50");
});

test("durations pick a readable unit", () => {
  assert.equal(formatDuration(null), "—");
  assert.equal(formatDuration(-5), "—");
  assert.equal(formatDuration(850), "850ms");
  assert.equal(formatDuration(4230), "4.2s");
  assert.equal(formatDuration(59_999), "59.9s");
  assert.equal(formatDuration(65_000), "1m 05s");
  assert.equal(formatDuration(7_380_000), "2h 03m");
});

test("counts and plurals", () => {
  assert.equal(formatCount(12345), "12,345");
  assert.equal(plural(1, "turn"), "1 turn");
  assert.equal(plural(3, "policy", "policies"), "3 policies");
});

test("dates use a fixed locale and an explicit time zone", () => {
  assert.equal(formatDate("2026-02-15"), "Feb 15, 2026");
  assert.equal(formatDate("2026-02-15T02:00:00Z", "America/New_York"), "Feb 14, 2026");
  assert.equal(formatDateTime("2026-02-15T14:05:09Z"), "Feb 15, 2026, 14:05 UTC");
  assert.equal(formatTime("2026-02-15T14:05:09Z"), "14:05:09");
  assert.equal(formatDate("not a date"), "not a date");
  assert.equal(formatDate("2026-02-15", "Not/AZone"), "Feb 15, 2026");
});

test("date ranges share the year when they can", () => {
  assert.equal(formatDateRange("2026-01-01T00:00:00+00:00", "2026-02-01T00:00:00+00:00"), "Jan 1 – Feb 1, 2026");
  assert.equal(formatDateRange("2025-12-01", "2026-01-01"), "Dec 1, 2025 – Jan 1, 2026");
});

test("relative times are computed against the given clock", () => {
  const now = Date.parse("2026-02-15T12:00:00Z");
  assert.equal(formatRelativeTime("2026-02-15T11:59:50Z", now), "just now");
  assert.equal(formatRelativeTime("2026-02-15T11:55:00Z", now), "5m ago");
  assert.equal(formatRelativeTime("2026-02-15T09:00:00Z", now), "3h ago");
  assert.equal(formatRelativeTime("2026-02-13T12:00:00Z", now), "2d ago");
  assert.equal(formatRelativeTime("2026-01-20T12:00:00Z", now), "Jan 20, 2026");
});

test("lateness compares the promised and actual ship times", () => {
  assert.deepEqual(lateness("2026-01-03T12:00:00Z", "2026-01-06T12:00:00Z"), { days: 3, label: "3 days late" });
  assert.deepEqual(lateness("2026-01-03T12:00:00Z", "2026-01-04T12:00:00Z"), { days: 1, label: "1 day late" });
  assert.deepEqual(lateness("2026-01-03T12:00:00Z", "2026-01-03T20:00:00Z"), { days: 0, label: "Under 1 day late" });
  assert.deepEqual(lateness("2026-01-03T12:00:00Z", "2026-01-02T12:00:00Z"), { days: 0, label: "On time" });
  assert.deepEqual(lateness("2026-01-03T12:00:00Z", null), { days: null, label: "Not shipped" });
  assert.deepEqual(lateness(null, "2026-01-03T12:00:00Z"), { days: null, label: "Unknown" });
});

test("error codes get short titles and unknown codes stay readable", () => {
  assert.equal(errorTitle("MODEL_TIMEOUT"), "Model timed out");
  assert.equal(errorTitle("APPROVAL_REJECTED"), "Rejected by reviewer");
  assert.equal(errorTitle("SOMETHING_NEW"), "Something new");
  assert.equal(errorTitle(null), "Unexpected error");
});

test("truncate shortens on a word boundary", () => {
  assert.equal(truncate("Find orders over $500 that shipped late last month", 30), "Find orders over $500 that…");
  assert.equal(truncate("  short   goal ", 30), "short goal");
  assert.equal(truncate("abcdefghijklmnopqrstuvwxyz", 10), "abcdefghi…");
});

test("date-only strings stay on their calendar day in any time zone", () => {
  assert.equal(formatDate("2026-02-01", "America/Los_Angeles"), "Feb 1, 2026");
  assert.equal(formatDateRange("2026-01-01", "2026-02-01", "America/Los_Angeles"), "Jan 1 – Feb 1, 2026");
  // Timestamps still convert: 01:00 UTC is the previous evening in Los Angeles.
  assert.equal(formatDate("2026-02-01T01:00:00Z", "America/Los_Angeles"), "Jan 31, 2026");
});

test("non-finite money and sub-second rounding are handled", () => {
  assert.equal(formatMoneyMinor(Number.NaN), "—");
  assert.equal(formatMoneyMinor(Number.POSITIVE_INFINITY), "—");
  assert.equal(formatDuration(999.6), "999ms");
});
