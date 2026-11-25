import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function expectNoViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const summary = results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(summary).toEqual([]);
}

async function completedRunPath(page: Page): Promise<string> {
  const created = await page.request.post("/api/runs", {
    data: { goal: "Find orders over $500 that shipped late last month and draft a refund email for each." },
  });
  const { id } = await created.json();
  await expect
    .poll(async () => (await (await page.request.get(`/api/runs/${id}`)).json()).status, { timeout: 20_000 })
    .toBe("completed");
  return `/runs/${id}`;
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test("the new-run page meets WCAG 2.2 AA checks", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Recent runs" })).toBeVisible();
      await expectNoViolations(page);
    });

    test("the runs page meets WCAG 2.2 AA checks", async ({ page }) => {
      await page.goto("/runs");
      await expect(page.getByRole("heading", { name: "Runs", exact: true })).toBeVisible();
      await expectNoViolations(page);
    });

    test("a completed run meets WCAG 2.2 AA checks, with tool cards open", async ({ page }) => {
      await page.goto(await completedRunPath(page));
      await expect(page.getByRole("heading", { name: "Run completed" })).toBeVisible();
      await page.getByRole("button", { name: /query_orders/ }).click();
      await page.getByRole("button", { name: /search_policies/ }).click();
      await expectNoViolations(page);
    });
  });
}

test("the signed-in header fits a 320 px screen: no wrapped nav labels, account button inside the gutter", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/");
  const links = await page.getByRole("navigation", { name: "Main" }).getByRole("link").all();
  expect(links).toHaveLength(2);
  for (const link of links) {
    // A label that wraps inside the 32 px link makes its content taller than the link.
    expect(await link.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
  }
  const accountRight = await page.getByRole("button", { name: /^Account/ }).evaluate((el) => el.getBoundingClientRect().right);
  expect(accountRight).toBeLessThanOrEqual(320 - 16);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
