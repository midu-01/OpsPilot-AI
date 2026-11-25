import { expect, test as setup } from "@playwright/test";
import { USERS, accountButton, signIn } from "./helpers";

// Runs before the chromium project: signs in each demo user through the real form and
// saves the browser state (the HttpOnly session cookie) for the specs to reuse.
for (const user of Object.values(USERS)) {
  setup(`sign in as ${user.name}`, async ({ page }) => {
    await page.goto("/login");
    await signIn(page, user.email);
    await expect(accountButton(page, user.name)).toBeVisible();
    await page.context().storageState({ path: user.storageState });
  });
}
