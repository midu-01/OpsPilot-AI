import { expect, type Page } from "@playwright/test";

export const RUN_URL = /\/runs\/[0-9a-f-]{36}$/;

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
