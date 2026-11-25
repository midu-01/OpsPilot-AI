import { defineConfig, devices } from "@playwright/test";
import { USERS } from "./tests/helpers";

const isExternalStack = process.env.E2E_EXTERNAL_STACK === "1";
const baseURL =
  process.env.PLAYWRIGHT_BASE_URL ?? (isExternalStack ? "http://127.0.0.1:13000" : "http://localhost:3000");

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    // Signs in Alex and Sam through the form and saves their cookies under tests/.auth/ (git-ignored).
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    // Every spec runs as Alex unless it says otherwise (auth.spec.ts uses Sam and signed-out browsers).
    {
      name: "chromium",
      testMatch: /.*\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: USERS.alex.storageState },
    },
  ],
});
