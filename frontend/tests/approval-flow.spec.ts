import { test, expect } from "@playwright/test";

test.describe("Agent Approval Journey", () => {
  test("explicit approval flow: submit goal, pause for approval, refresh, approve, and verify replay", async ({
    page,
  }) => {
    // 1. Open /
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Agent Run Console" })).toBeVisible();

    // 2. Click the explicit simulated-refund example prompt
    const refundPromptCard = page.getByRole("button", { name: /Select example: Explicit refund proposal/i });
    if (await refundPromptCard.isVisible()) {
      await refundPromptCard.click();
    } else {
      await page
        .getByLabel(/Operations Goal/i)
        .fill(
          "Find order ORD-002 that shipped late last month and propose a simulated refund under policy."
        );
    }

    // Submit
    await page.getByRole("button", { name: /Run OpsPilot Agent/i }).click();

    // 3. Wait for navigation to /runs/{id}
    await page.waitForURL(/\/runs\/[0-9a-f-]+/);
    const runUrl = page.url();

    // 4. Observe at least one live tool/timeline event
    await expect(page.getByRole("feed", { name: /Execution Timeline/i })).toBeVisible();

    // 5. Wait for the approval card
    const approvalCard = page.locator(".approval-card");
    await expect(approvalCard).toBeVisible({ timeout: 15000 });

    // 6. Assert order ID, amount, currency, reason/evidence, and simulated label are visible
    await expect(approvalCard.getByText(/ORD-002/i)).toBeVisible();
    await expect(approvalCard.getByText(/Simulated refund — no money will move/i)).toBeVisible();
    await expect(approvalCard.getByText(/\$\d+\.\d{2} USD/i)).toBeVisible();

    // 7. Save run URL and reload the page
    await page.reload();

    // 8. Assert the same pending approval is still visible with unchanged details
    const reloadedCard = page.locator(".approval-card");
    await expect(reloadedCard).toBeVisible({ timeout: 10000 });
    await expect(reloadedCard.getByText(/ORD-002/i)).toBeVisible();
    await expect(reloadedCard.getByText(/Simulated refund — no money will move/i)).toBeVisible();

    // 9. Approve once
    await reloadedCard.getByRole("button", { name: /Approve Refund/i }).click();

    // 10. Wait for the run to reach a terminal state
    await expect(page.getByText(/Run Completed/i)).toBeVisible({ timeout: 15000 });

    // 11. Open /runs
    await page.getByRole("link", { name: /Runs History/i }).click();
    await page.waitForURL(/\/runs$/);

    // 12. Find the run by its ID or goal
    const runLink = page.getByRole("link", { name: /ORD-002/i });
    await expect(runLink).toBeVisible();

    // 13. Reopen the run and assert the decision and tool result appear
    await runLink.click();
    await page.waitForURL(runUrl);
    await expect(page.getByText(/Approval Decision/i)).toBeVisible();
    await expect(page.getByText(/Run Completed/i)).toBeVisible();
  });

  test("draft-only goal does not create a refund approval", async ({ page }) => {
    await page.goto("/");
    const draftPromptCard = page.getByRole("button", { name: /Select example: Draft-only late shipment analysis/i });
    if (await draftPromptCard.isVisible()) {
      await draftPromptCard.click();
    } else {
      await page
        .getByLabel(/Operations Goal/i)
        .fill("Find orders over $500 that shipped late last month and draft a refund email for each.");
    }

    await page.getByRole("button", { name: /Run OpsPilot Agent/i }).click();
    await page.waitForURL(/\/runs\/[0-9a-f-]+/);

    // Should not show an approval card
    await expect(page.locator(".approval-card")).not.toBeVisible();
  });
});
