import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:3319",
    storageState: "test-results/.auth-state.json",
    channel: process.env.PLAYWRIGHT_CHANNEL === "chrome" ? "chrome" : undefined,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: "http://127.0.0.1:3319/api/settings/configured",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
