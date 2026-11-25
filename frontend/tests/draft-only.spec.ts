import { expect, test } from "@playwright/test";
import { startPreset, traceSteps } from "./helpers";

test("a draft-only goal runs read tools in turn order, renders email drafts and never asks for approval", async ({ page }) => {
  await startPreset(page, /Draft late-shipment emails/);
  await expect(page.getByRole("heading", { name: "Run completed" })).toBeVisible({ timeout: 20_000 });

  // Each tool call sits under the turn that requested it, and the answer comes last.
  expect(await traceSteps(page)).toEqual(["Goal", "Turn 1", "Turn 2", "Turn 3", "Answer", "Run completed"]);
  const feed = page.getByRole("feed", { name: "Trace" });
  await expect(feed.getByRole("article", { name: "Turn 1" })).toContainText("date_math");
  await expect(feed.getByRole("article", { name: "Turn 2" })).toContainText("Late orders over $500.00, shipped Jan 1 – Feb 1, 2026");
  await expect(feed.getByRole("article", { name: "Turn 3" })).toContainText("search_policies");

  await expect(page.getByRole("article", { name: "Draft Email 1" })).toContainText("Subject");
  await expect(page.getByText(/EMAIL-01/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve refund" })).toHaveCount(0);

  // The query_orders view shows the orders table with lateness.
  await feed.getByRole("button", { name: /query_orders/ }).click();
  await expect(feed.getByRole("table", { name: "Orders returned by query_orders" })).toContainText("ORD-1001");

  // A full reload replays the stored trace with the same structure.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Run completed" })).toBeVisible();
  expect(await traceSteps(page)).toEqual(["Goal", "Turn 1", "Turn 2", "Turn 3", "Answer", "Run completed"]);
});
