import { expect, test } from "@playwright/test";
import { approvalCard, startPreset } from "./helpers";

const REASON = "The customer asked for store credit instead.";

test("rejecting a refund requires a reason and sends it back to the agent", async ({ page }) => {
  await startPreset(page, /Refund ORD-1001, then reject it/);
  await expect(approvalCard(page)).toContainText("$62.50 USD", { timeout: 20_000 });

  await page.getByRole("button", { name: "Reject…" }).click();
  await page.getByRole("button", { name: "Reject refund" }).click();
  await expect(page.getByText("Enter a reason to reject the refund.")).toBeVisible();
  await expect(page.getByLabel("Why are you rejecting this refund?")).toBeFocused();

  await page.getByLabel("Why are you rejecting this refund?").fill(REASON);
  await page.getByRole("button", { name: "Reject refund" }).click();

  await expect(page.getByRole("heading", { name: "Run completed" })).toBeVisible({ timeout: 20_000 });
  // Focus moves to the decision record, so keyboard users keep their place.
  await expect(page.getByRole("article", { name: "Refund rejected" })).toBeFocused();
  await expect(page.getByRole("article", { name: "Refund rejected" })).toContainText(REASON);
  await expect(page.getByRole("button", { name: /issue_refund/ })).toContainText("Rejected by you");
  await expect(page.getByRole("article", { name: "Answer" })).toContainText(`No refund was issued for ORD-1001: ${REASON}`);
});
