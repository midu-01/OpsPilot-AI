import { defineConfig, devices } from "@playwright/test";

const isExternalStack = process.env.E2E_EXTERNAL_STACK === "1";
const baseURL =
  process.env.PLAYWRIGHT_BASE_URL ?? (isExternalStack ? "http://127.0.0.1:13000" : "http://localhost:3000");

export default defineConfig({
  testDir: "./tests",
  testMatch: /.*\.spec\.ts/,
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
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
