import { existsSync, readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import postgres from "postgres";

export type Fixtures = { password: string; farm: string; city: string; farmAoi: string; cityAoi: string; trialAoi: string; detection: string; zone: string };

/**
 * Sign-in is limited to 5 attempts per minute per address and path; the suite
 * signs in through the form more often than that, from one address. Clears
 * the limiter rows in the (development) database between such tests.
 */
export async function clearSignInRateLimit() {
  if (!process.env.DATABASE_OWNER_URL && existsSync(".env.local")) process.loadEnvFile(".env.local");
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) throw new Error("DATABASE_OWNER_URL is needed to reset the sign-in rate limit between e2e tests.");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`delete from auth_rate_limit`;
  } finally {
    await sql.end();
  }
}

/** Fill and submit the sign-in form. */
export async function signInWithForm(page: Page, identifier: string, password: string, next?: string) {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  await page.getByLabel("Username").fill(identifier);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}
export const fx = (): Fixtures => JSON.parse(readFileSync("var/e2e-fixtures.json", "utf8")) as Fixtures;

/** Reuse the session created in global setup (see USERS there). */
export async function signIn(page: Page, email: string, next = "/app") {
  const state = JSON.parse(readFileSync(`var/e2e-auth-${email.split("@")[0]}.json`, "utf8")) as { cookies: Parameters<ReturnType<Page["context"]>["addCookies"]>[0] };
  await page.context().clearCookies();
  await page.context().addCookies(state.cookies);
  await page.goto(next);
}

/** Click on the map the way a pointer does: move there, then press. */
export async function mapClick(page: Page, x: number, y: number) {
  await page.mouse.move(x, y, { steps: 5 });
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(250);
}
