/**
 * Integration tests run against a separate database (default: oryn_test on
 * the same server) so they can truncate tables freely.
 *
 *   TEST_DATABASE_URL        app-role connection (RLS enforced)
 *   TEST_DATABASE_OWNER_URL  owner connection (migrations, fixtures)
 *
 * When unset, both are derived from DATABASE_URL / DATABASE_OWNER_URL by
 * swapping the database name for "oryn_test".
 */
import { existsSync } from "node:fs";
import { loadEnvConfig } from "@next/env";

function swapDb(url: string | undefined, name: string): string | undefined {
  if (!url) return undefined;
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

export function testDatabaseUrls(): { app: string; owner: string } {
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  // Next.js deliberately skips .env.local when NODE_ENV=test; developers keep
  // their local database URLs there, so read it explicitly (without
  // overriding variables already set, e.g. in CI).
  if (!process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL && existsSync(".env.local")) {
    process.loadEnvFile(".env.local");
  }
  const app = process.env.TEST_DATABASE_URL ?? swapDb(process.env.DATABASE_URL, "oryn_test");
  const owner = process.env.TEST_DATABASE_OWNER_URL ?? swapDb(process.env.DATABASE_OWNER_URL, "oryn_test");
  if (!app || !owner) {
    throw new Error("Integration tests need DATABASE_URL and DATABASE_OWNER_URL (or TEST_DATABASE_URL / TEST_DATABASE_OWNER_URL).");
  }
  if (!/oryn_test|_test\b|test/.test(new URL(owner).pathname)) {
    throw new Error(`Refusing to run integration tests against a database that does not look like a test database: ${new URL(owner).pathname}`);
  }
  return { app, owner };
}

/**
 * End-to-end tests run against their own database (default: oryn_e2e on the
 * same server), so their synthetic organizations, accounts, and fixture
 * measurements never mix with a developer's working data.
 *
 *   E2E_DATABASE_URL / E2E_DATABASE_OWNER_URL   explicit connections
 *
 * When unset, both are derived from DATABASE_URL / DATABASE_OWNER_URL
 * (including .env.local) by swapping the database name for "oryn_e2e".
 */
export function e2eDatabaseUrls(): { app: string; owner: string } {
  if (!process.env.E2E_DATABASE_URL && !process.env.DATABASE_URL && existsSync(".env.local")) {
    process.loadEnvFile(".env.local");
  }
  const app = process.env.E2E_DATABASE_URL ?? swapDb(process.env.DATABASE_URL, "oryn_e2e");
  const owner = process.env.E2E_DATABASE_OWNER_URL ?? swapDb(process.env.DATABASE_OWNER_URL, "oryn_e2e");
  if (!app || !owner) throw new Error("End-to-end tests need DATABASE_URL and DATABASE_OWNER_URL (or E2E_DATABASE_URL / E2E_DATABASE_OWNER_URL).");
  for (const url of [app, owner]) {
    if (!/e2e|test/.test(new URL(url).pathname)) {
      throw new Error(`Refusing to run end-to-end tests against a database that does not look like a test database: ${new URL(url).pathname}`);
    }
  }
  return { app, owner };
}
