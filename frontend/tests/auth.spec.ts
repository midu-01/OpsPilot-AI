import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { SIGNED_OUT, USERS, accountButton, approvalCard, signIn, startPreset } from "./helpers";

const SESSION_COOKIE = "opspilot_session";
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function expectNoViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const summary = results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(summary).toEqual([]);
}

test.describe("signed out", () => {
  test.use({ storageState: SIGNED_OUT });

  test("a protected page sends the user to sign in, then back to that page", async ({ page }) => {
    await page.goto("/runs?page=2");
    await expect(page).toHaveURL(/\/login\?next=%2Fruns%3Fpage%3D2$/);
    await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0); // signed-out header

    await signIn(page, USERS.alex.email);
    await expect(page).toHaveURL(/\/runs\?page=2$/);
    await expect(page.getByRole("heading", { name: "Runs", exact: true })).toBeVisible();
    await expect(accountButton(page, USERS.alex.name)).toBeVisible();
  });

  test("a wrong password is refused, keeps the email and moves focus to the message", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill(USERS.alex.email);
    await page.getByLabel("Password", { exact: true }).fill("not-the-demo-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    const message = page.getByRole("alert").filter({ hasText: "Sign-in failed" });
    await expect(message).toContainText("The email or password is incorrect.");
    await expect(page.locator(":focus")).toContainText("The email or password is incorrect.");
    await expect(page.getByLabel("Email", { exact: true })).toHaveValue(USERS.alex.email);
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("signing out ends the session, and protected pages redirect again", async ({ page }) => {
    // A session of its own: signing out must not revoke the one saved in tests/.auth.
    await page.goto("/login");
    await signIn(page, USERS.alex.email);
    const saved = (await page.context().cookies()).find((cookie) => cookie.name === SESSION_COOKIE);
    expect(saved).toBeDefined();
    await accountButton(page, USERS.alex.name).click();
    await page.getByRole("button", { name: "Sign out" }).click();

    await page.waitForURL(/\/login$/);
    await expect(page.getByRole("button", { name: /^Account/ })).toHaveCount(0);
    await page.goto("/runs");
    await expect(page).toHaveURL(/\/login\?next=%2Fruns$/);

    // The backend revoked the token: the old cookie, put back, is refused, and the pages send
    // the browser to sign in (no redirect loop) instead of trusting it.
    await page.context().addCookies([saved!]);
    expect((await page.request.get("/api/runs")).status()).toBe(401);
    await page.goto("/runs");
    await expect(page).toHaveURL(/\/login\?next=%2Fruns$/);
    await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("without a session cookie, pages get a 307 to sign in and /api gets a JSON 401", async ({ page }) => {
    // proxy.ts answers the page; its matcher must leave /api to the proxy route, which answers 401.
    const pageResponse = await page.request.get("/runs?page=2", { maxRedirects: 0 });
    expect(pageResponse.status()).toBe(307);
    expect(pageResponse.headers()["location"]).toMatch(/\/login\?next=%2Fruns%3Fpage%3D2$/);
    const apiResponse = await page.request.get("/api/runs", { maxRedirects: 0 });
    expect(apiResponse.status()).toBe(401);
    expect(await apiResponse.json()).toEqual({ detail: "Sign in to continue" });
  });

  test("the demo account buttons fill in the email, and the sign-in page fits a 375 px screen", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 740 });
    await page.goto("/login");
    await page.getByRole("button", { name: /Sam Chen/ }).click();
    await expect(page.getByLabel("Email", { exact: true })).toHaveValue(USERS.sam.email);
    await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});

test("Sam cannot open Alex's run, and it is not in Sam's run list", async ({ page, browser, baseURL }) => {
  // `page` is signed in as Alex (the project's storage state).
  const created = await page.request.post("/api/runs", {
    data: { goal: "Find orders over $500 that shipped late last month and draft a refund email for each." },
  });
  expect(created.status()).toBe(202);
  const { id } = await created.json();
  await page.goto(`/runs/${id}`);
  await expect(page.getByRole("feed", { name: "Trace" })).toBeVisible();

  const samContext = await browser.newContext({ baseURL, storageState: USERS.sam.storageState });
  try {
    const sam = await samContext.newPage();
    await sam.goto(`/runs/${id}`);
    await expect(sam.getByRole("heading", { name: "Run not found" })).toBeVisible();
    expect((await sam.request.get(`/api/runs/${id}`)).status()).toBe(404);

    await sam.goto("/runs");
    await expect(sam.getByRole("heading", { name: "Runs", exact: true })).toBeVisible();
    await expect(sam.locator(`a[href="/runs/${id}"]`)).toHaveCount(0);
  } finally {
    await samContext.close();
  }
});

test.describe("when the session ends while a page is open", () => {
  // clearCookies() and addCookies() change only this test's browser, never the saved Alex session.

  test("a redirect to sign in during navigation also switches the header to signed out", async ({ page, baseURL }) => {
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    // A token-shaped cookie the backend does not know: proxy.ts lets it through, FastAPI answers 401.
    await page.context().addCookies([{ name: SESSION_COOKIE, value: "x".repeat(43), url: baseURL! }]);
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Runs" }).click();

    await expect(page).toHaveURL(/\/login\?next=%2Fruns$/);
    await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Account/ })).toHaveCount(0);
  });

  test("Start run goes to sign in, and the goal is back in the composer afterwards", async ({ page }) => {
    const goal = "Find orders over $500 that shipped late,\nthen draft a refund email for each.";
    await page.goto("/");
    await page.getByLabel("Operations goal").fill(goal);
    await page.context().clearCookies();
    await page.getByRole("button", { name: "Start run" }).click();

    await expect(page).toHaveURL(/\/login\?next=%2F%3Fgoal%3D/);
    await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
    await signIn(page, USERS.alex.email);
    await expect(page.getByLabel("Operations goal")).toHaveValue(goal.replace("\n", " "));
  });

  test("approve and stop go to sign in and back to the run, without reaching the backend", async ({ page }) => {
    const runUrl = await startPreset(page, /Refund ORD-1001, then reject it/);
    await expect(approvalCard(page)).toBeVisible({ timeout: 20_000 });
    const loginUrl = new RegExp(`/login\\?next=${encodeURIComponent(new URL(runUrl).pathname)}$`);
    const confirmStop = page.getByRole("group", { name: "Confirm stop" });

    await page.context().clearCookies();
    await page.getByRole("button", { name: "Approve refund" }).click();
    await expect(page).toHaveURL(loginUrl);
    await signIn(page, USERS.alex.email);
    await expect(page).toHaveURL(runUrl);
    await expect(approvalCard(page)).toBeVisible(); // the decision was never sent

    await page.context().clearCookies();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await confirmStop.getByRole("button", { name: "Stop run" }).click();
    await expect(page).toHaveURL(loginUrl);
    await signIn(page, USERS.alex.email);
    await expect(page).toHaveURL(runUrl);
    await expect(approvalCard(page)).toBeVisible(); // the stop was never sent

    // Leave no run waiting for approval in the E2E database.
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await confirmStop.getByRole("button", { name: "Stop run" }).click();
    await expect(page.getByRole("heading", { name: "Run stopped" })).toBeVisible({ timeout: 20_000 });
  });
});

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`sign-in page, ${colorScheme} theme`, () => {
    test.use({ colorScheme, storageState: SIGNED_OUT });

    test("meets WCAG 2.2 AA checks, also while showing an error", async ({ page }) => {
      await page.goto("/login");
      await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
      await expectNoViolations(page);

      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page.getByRole("alert").filter({ hasText: "Enter your email address." })).toBeVisible();
      await expect(page.getByLabel("Email", { exact: true })).toHaveAttribute("aria-invalid", "true");
      await expectNoViolations(page);
    });
  });
}
