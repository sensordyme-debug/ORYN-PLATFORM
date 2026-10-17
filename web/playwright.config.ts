import { defineConfig, devices } from "@playwright/test";
import { e2eDatabaseUrls } from "./tests/helpers/test-env";

/**
 * End-to-end tests against a running app (default http://localhost:3000)
 * backed by their own database (oryn_e2e, migrated by the global setup).
 * Fixtures are synthetic e2e-* organizations created by
 * scripts/oryn/e2e-fixtures.ts in the global setup.
 *
 * The suite starts its own dev server on that database. Stop any other
 * `next dev` in this directory first (Next.js allows one per directory); with
 * E2E_BASE_URL set, the server at that address must use the same database.
 *
 *   npm run test:e2e
 */
const db = e2eDatabaseUrls();
// Inherited by the global setup, the fixture script, the helpers, and the
// dev server below.
process.env.DATABASE_URL = db.app;
process.env.DATABASE_OWNER_URL = db.owner;
process.env.ORYN_STORAGE_DIR = "./var/e2e-storage";
export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }, testIgnore: /responsive\.spec\.ts/ },
    // Tablet portrait (iPad Pro 11"): below the lg breakpoint, so navigation collapses.
    { name: "tablet", use: { ...devices["Desktop Chrome"], viewport: { width: 834, height: 1194 } }, testMatch: /responsive\.spec\.ts/ },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:3000/login",
        // Never reuse a server that may be running on the development database.
        reuseExistingServer: false,
        timeout: 180_000,
        env: { DATABASE_URL: db.app, DATABASE_OWNER_URL: db.owner, ORYN_STORAGE_DIR: "./var/e2e-storage" },
      },
});
