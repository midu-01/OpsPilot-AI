import { expect, test } from "@playwright/test";
import { approvalCard, startPreset, traceSteps } from "./helpers";

// Needs a fresh stack: approving ORD-1006 writes to the simulated ledger once.
test("a refund approval survives a reload, then resumes the run and replays from history", async ({ page }) => {
  const runUrl = await startPreset(page, /Refund ORD-1006/);
  await expect(page.getByRole("feed", { name: "Trace" })).toBeVisible();

  const card = approvalCard(page);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText("$84.51 USD");
  await expect(card).toContainText("ORD-1006");
  await expect(card).toContainText("Approving records a simulated $84.51 USD refund for ORD-1006. No money moves.");
  await expect(page).toHaveTitle(/^Approval needed · /);
  await expect(page.getByRole("button", { name: "Review approval" })).toBeVisible();

  await page.reload();
  await expect(approvalCard(page)).toBeVisible({ timeout: 10_000 });
  await expect(approvalCard(page)).toContainText("$84.51 USD");
  await expect(page.getByText("Live", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Approve refund" }).click();
  await expect(page.getByRole("heading", { name: "Run completed" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Refund approved" })).toBeVisible();
  await expect(page.getByRole("button", { name: /issue_refund/ })).toContainText("$84.51 USD recorded");
  await expect(page).not.toHaveTitle(/Approval needed/);
  const liveSteps = await traceSteps(page);

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Runs" }).click();
  await page.waitForURL(/\/runs$/);
  await page.getByRole("link", { name: /simulated refund for ORD-1006/ }).first().click();
  await page.waitForURL(runUrl);
  await expect(page.getByText("Replayed from history")).toBeVisible();
  expect(await traceSteps(page)).toEqual(liveSteps);
});
