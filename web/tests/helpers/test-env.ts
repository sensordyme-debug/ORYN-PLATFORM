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
