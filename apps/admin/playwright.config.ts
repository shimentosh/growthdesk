import { defineConfig, devices } from "@playwright/test";

/*
 * UI smoke tests for the operator console.
 *
 *   pnpm --filter @growthdesk/admin run test:ui
 *
 * Runs against ADMIN_URL when set (an already-running console), otherwise
 * starts `next dev` on 3602 itself (or reuses one that is already up). The
 * smoke specs need no database: they only exercise the login page and the
 * signed-out redirect.
 */
const baseURL = process.env.ADMIN_URL ?? "http://localhost:3602";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.ADMIN_URL
    ? undefined
    : { command: "pnpm run dev", url: `${baseURL}/login`, reuseExistingServer: true, timeout: 120_000 },
});
