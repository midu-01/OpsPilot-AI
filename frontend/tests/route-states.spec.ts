import { expect, test } from "@playwright/test";

test("an unknown run and a malformed run ID both show not found", async ({ page }) => {
  for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
    await page.goto(`/runs/${id}`);
    await expect(page.getByRole("heading", { name: "Run not found" })).toBeVisible();
  }
});

test("retry links prefill the composer without starting a run", async ({ page }) => {
  await page.goto(`/?${new URLSearchParams({ goal: "Find late orders again" })}`);
  await expect(page.getByLabel("Operations goal")).toHaveValue("Find late orders again");
  await expect(page).toHaveURL(/\/\?goal=/);
});

test("runs open from the list with the keyboard", async ({ page }) => {
  await page.goto("/runs");
  const firstRun = page.getByRole("table").getByRole("link").first();
  await expect(firstRun).toBeVisible();
  await firstRun.focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/runs\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("feed", { name: "Trace" })).toBeVisible();
});

test("the runs page rejects an invalid page number by showing page 1", async ({ page }) => {
  await page.goto("/runs?page=abc");
  await expect(page.getByText(/^Page 1 of \d+$/)).toBeVisible();
});
