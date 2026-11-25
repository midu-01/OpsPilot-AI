import { expect, test } from "@playwright/test";
import { approvalCard, startPreset } from "./helpers";

test("stopping a run that waits for approval cancels the approval and keeps the trace", async ({ page }) => {
  await startPreset(page, /Refund ORD-1001, then reject it/);
  await expect(approvalCard(page)).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Stop", exact: true }).click();
  const confirm = page.getByRole("group", { name: "Confirm stop" });
  await expect(confirm).toContainText("Stop and cancel the pending approval?");
  await confirm.getByRole("button", { name: "Stop run" }).click();

  await expect(page.getByRole("heading", { name: "Run stopped" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Approval cancelled" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve refund" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Start again with this goal" })).toHaveAttribute("href", /\?goal=/);
});
