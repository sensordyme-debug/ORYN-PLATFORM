import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { request } from "@playwright/test";
import { clearSignInRateLimit } from "./helpers";

export const USERS = ["e2e-analyst@oryn.local", "e2e-viewer@oryn.local", "e2e-city-admin@oryn.local", "e2e-admin@oryn.local"] as const;
export const stateFile = (email: string) => `var/e2e-auth-${email.split("@")[0]}.json`;

/**
 * Migrates the e2e database, creates synthetic fixtures (with a password
 * generated for this run), then signs each test user in ONCE through the
 * real /api/auth endpoint and saves the session — the suite must not trip the
 * login rate limit (5 attempts per minute per path and address), which it
 * exercises separately. Specs that sign in through the form clear the limit
 * first (clearSignInRateLimit).
 */
export default async function globalSetup() {
  // Run tsx's CLI with this Node directly: `npx` is npx.cmd on Windows, which
  // execFileSync cannot start without a shell.
  const tsx = path.join("node_modules", "tsx", "dist", "cli.mjs");
  // playwright.config.ts has pointed DATABASE_URL at the e2e database.
  execFileSync(process.execPath, [tsx, "scripts/oryn/migrate.ts"], { env: { ...process.env, LOG_LEVEL: "error" }, encoding: "utf8" });
  const out = execFileSync(process.execPath, [tsx, "scripts/oryn/e2e-fixtures.ts"], { env: { ...process.env, LOG_LEVEL: "error" }, encoding: "utf8" });
  const line = out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  if (!line) throw new Error(`e2e fixtures did not report ids:\n${out}`);
  mkdirSync("var", { recursive: true });
  writeFileSync("var/e2e-fixtures.json", line);
  const { password } = JSON.parse(line) as { password: string };
  const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
  await clearSignInRateLimit();
  for (const email of USERS) {
    const ctx = await request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } });
    const r = await ctx.post("/api/auth/sign-in/email", { data: { email, password } });
    if (!r.ok()) throw new Error(`Sign-in for ${email} failed: ${r.status()} ${await r.text()}`);
    await ctx.storageState({ path: stateFile(email) });
    await ctx.dispose();
  }
}
