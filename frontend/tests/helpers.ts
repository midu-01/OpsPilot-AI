import path from "node:path";
import { expect, type Page } from "@playwright/test";

export const RUN_URL = /\/runs\/[0-9a-f-]{36}$/;

/** The seeded demo password (DEMO_USER_PASSWORD on the backend). */
export const DEMO_PASSWORD = process.env.E2E_DEMO_PASSWORD ?? "opspilot-demo";

/** The two demo users. auth.setup.ts saves each one's signed-in browser state to `storageState`. */
export const USERS = {
  alex: { email: "alex@opspilot.test", name: "Alex Rivera", storageState: path.join(__dirname, ".auth", "alex.json") },
  sam: { email: "sam@opspilot.test", name: "Sam Chen", storageState: path.join(__dirname, ".auth", "sam.json") },
};

/** A browser with no session cookie. */
export const SIGNED_OUT = { cookies: [], origins: [] };

/** Fills in the sign-in form on the current page and submits it; resolves once the browser has left /login. */
export async function signIn(page: Page, email: string, password = DEMO_PASSWORD): Promise<void> {
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname !== "/login");
}

/** The header's account button, named after the signed-in user. */
export function accountButton(page: Page, name: string) {
  return page.getByRole("button", { name: `Account: ${name}` });
}

/** Fills the composer from a scenario card and starts the run; resolves on the console URL. */
export async function startPreset(page: Page, presetTitle: RegExp): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: presetTitle }).click();
  await expect(page.getByLabel("Operations goal")).not.toHaveValue("");
  await page.getByRole("button", { name: "Start run" }).click();
  await page.waitForURL(RUN_URL);
  return page.url();
}

/** Step titles of the trace, top to bottom. */
export async function traceSteps(page: Page): Promise<string[]> {
  return page.getByRole("feed", { name: "Trace" }).locator("article > header h3").allInnerTexts();
}

export function approvalCard(page: Page) {
  return page.getByRole("article", { name: "Your approval is needed" });
}
