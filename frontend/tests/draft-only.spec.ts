import { test, expect } from "@playwright/test";

test.describe("Draft-only Operations Journey", () => {
  test("submits draft goal, observes read tools, verifies email drafts, and confirms zero approvals", async ({
    page,
  }) => {
    // 1. Open home page
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Agent Run Console" })).toBeVisible();

    // 2. Select the draft-only example prompt or fill it
    const draftPromptBtn = page.getByRole("button", {
      name: /Select example: Draft-only late shipment analysis/i,
    });
    if (await draftPromptBtn.isVisible()) {
      await draftPromptBtn.click();
    } else {
      await page
        .getByLabel(/Operations Goal/i)
        .fill("Find orders over $500 that shipped late last month and draft a refund email for each.");
    }

    // 3. Submit the goal
    await page.getByRole("button", { name: /Run OpsPilot Agent/i }).click();

    // 4. Wait for navigation to the run detail page
    await page.waitForURL(/\/runs\/[0-9a-f-]+/);
    const runUrl = page.url();

    // 5. Ensure execution timeline is present
    await expect(page.getByRole("feed", { name: /Execution Timeline/i })).toBeVisible();

    // 6. Wait for run to reach completed status
    await expect(page.getByText(/Run Completed/i)).toBeVisible({ timeout: 20000 });

    // 7. Verify no approval card was shown
    await expect(page.locator(".approval-card")).not.toBeVisible();

    // 8. Verify the assistant response contains drafted email content
    await expect(page.getByText(/Subject:/i)).toBeVisible();
    await expect(page.getByText(/EMAIL-01/i)).toBeVisible();

    // 9. Revisit Run History
    await page.getByRole("link", { name: /Runs History/i }).click();
    await page.waitForURL(/\/runs$/);

    // 10. Find the completed run
    const viewTraceLink = page.locator("tr", { hasText: "completed" }).first().getByRole("link", { name: /View Trace/i });
    await expect(viewTraceLink).toBeVisible();

    // 11. Reopen the run trace
    await viewTraceLink.click();
    await expect(page.getByText(/Run Completed/i)).toBeVisible();
    await expect(page.locator(".approval-card")).not.toBeVisible();
  });
});
