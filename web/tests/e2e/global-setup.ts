import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { request } from "@playwright/test";
import { clearSignInRateLimit } from "./helpers";

export const USERS = ["e2e-analyst@oryn.local", "e2e-viewer@oryn.local", "e2e-city-admin@oryn.local", "e2e-admin@oryn.local"] as const;
export const stateFile = (email: string) => `var/e2e-auth-${email.split("@")[0]}.json`;

/**
 * Creates synthetic fixtures, then signs each test user in ONCE through the
 * real /api/auth endpoint and saves the session — the suite must not trip the
 * login rate limit (5 attempts per minute per path and address), which it
 * exercises separately. Specs that sign in through the form clear the limit
 * first (clearSignInRateLimit).
 */
export default async function globalSetup() {
  const out = execFileSync("npx", ["tsx", "scripts/oryn/e2e-fixtures.ts"], { env: { ...process.env, LOG_LEVEL: "error" }, encoding: "utf8" });
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
