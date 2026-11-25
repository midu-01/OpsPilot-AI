import { expect, test } from "@playwright/test";

const RUN_ID = "01234567-89ab-4cde-8fab-0123456789ab";
const GOAL = "Find late orders and draft refund emails without issuing refunds.";

test("goal submission uses the console origin and navigates after HTTP 202", async ({ page }) => {
  let requestUrl = "";
  let submittedGoal = "";
  await page.route("**/runs", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    requestUrl = route.request().url();
    submittedGoal = route.request().postDataJSON().goal;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        id: RUN_ID,
        goal: submittedGoal,
        status: "queued",
        step_count: 0,
        total_tokens: 0,
        token_usage_complete: null,
        cost_is_upper_bound: false,
        estimated_cost_usd: null,
        duration_ms: null,
        created_at: "2026-02-15T12:00:00Z",
        updated_at: "2026-02-15T12:00:00Z",
      }),
    });
  });

  await page.goto("/");
  const origin = new URL(page.url()).origin;
  await page.getByLabel(/Operations goal/i).fill(GOAL);
  await page.getByRole("button", { name: "Start run" }).click();
  await page.waitForURL(`${origin}/runs/${RUN_ID}`);

  expect(requestUrl).toBe(`${origin}/api/runs`);
  expect(submittedGoal).toBe(GOAL);
});

test("a network failure keeps the goal and displays recovery instructions", async ({ page }) => {
  await page.route("**/runs", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.abort("failed");
  });

  await page.goto("/");
  await page.getByLabel(/Operations goal/i).fill(GOAL);
  await page.getByRole("button", { name: "Start run" }).click();

  const alert = page.getByRole("alert").filter({ hasText: "The run was not started" });
  await expect(alert).toContainText(/backend services are running/i);
  await expect(page.getByLabel(/Operations goal/i)).toHaveValue(GOAL);
  await expect(page.getByRole("button", { name: "Start run" })).toBeEnabled();
});

test("Ctrl+Enter submits, and a blank goal is refused without a request", async ({ page }) => {
  let posts = 0;
  await page.route("**/runs", async (route) => {
    if (route.request().method() === "POST") posts += 1;
    await route.abort("failed");
  });
  await page.goto("/");
  await page.getByLabel(/Operations goal/i).fill("   ");
  await page.getByLabel(/Operations goal/i).press("Control+Enter");
  await expect(page.getByRole("alert").filter({ hasText: "Enter a goal for the agent." })).toBeVisible();
  expect(posts).toBe(0);
});
