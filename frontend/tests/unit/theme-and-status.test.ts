import assert from "node:assert/strict";
import test from "node:test";
import { parseThemePreference, themeCookie } from "../../src/lib/theme.ts";
import {
  approvalStatusMeta,
  canStop,
  humanizeStatus,
  isTerminalStatus,
  runStatusMeta,
  toolStatusMeta,
} from "../../src/lib/status.ts";
import { cx } from "../../src/lib/cx.ts";

test("theme preference accepts only light or dark overrides", () => {
  assert.equal(parseThemePreference("dark"), "dark");
  assert.equal(parseThemePreference("light"), "light");
  assert.equal(parseThemePreference("system"), "system");
  assert.equal(parseThemePreference("purple"), "system");
  assert.equal(parseThemePreference(undefined), "system");
});

test("choosing System clears the theme cookie; other choices persist for a year", () => {
  assert.match(themeCookie("system"), /Max-Age=0/);
  assert.match(themeCookie("dark"), /^opspilot-theme=dark; Path=\/; Max-Age=31536000; SameSite=Lax$/);
});

test("every run status has a label, a tone and an icon", () => {
  assert.deepEqual(runStatusMeta("awaiting_approval"), { label: "Needs approval", tone: "warning", icon: "waiting" });
  assert.deepEqual(runStatusMeta("failed"), { label: "Failed", tone: "danger", icon: "failed" });
  assert.equal(runStatusMeta("cancelling").label, "Stopping");
});

test("unknown statuses fall back to a readable neutral label", () => {
  assert.deepEqual(toolStatusMeta("retrying_later"), { label: "Retrying later", tone: "neutral", icon: "queued" });
  assert.equal(humanizeStatus(""), "Unknown");
});

test("tool and approval statuses map to their own labels", () => {
  assert.equal(toolStatusMeta("completed").label, "Done");
  assert.equal(toolStatusMeta("awaiting_approval").tone, "warning");
  assert.equal(approvalStatusMeta("rejected").tone, "danger");
  assert.equal(approvalStatusMeta("cancelled").label, "Cancelled");
});

test("terminal and stoppable statuses", () => {
  assert.equal(isTerminalStatus("completed"), true);
  assert.equal(isTerminalStatus("cancelling"), false);
  assert.equal(canStop("awaiting_approval"), true);
  assert.equal(canStop("cancelling"), false);
  assert.equal(canStop("failed"), false);
});

test("cx joins truthy class names", () => {
  assert.equal(cx("a", false, null, undefined, "b"), "a b");
});
