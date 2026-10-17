import { expect, test } from "@playwright/test";
import { clearSignInRateLimit, fx, signIn, signInWithForm } from "./helpers";

test.beforeEach(clearSignInRateLimit);

test("the marketing site still renders", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "ORYN — home" })).toBeVisible();
  await page.goto("/technology");
  await expect(page.locator("main")).toBeVisible();
});

test("unauthenticated platform requests are redirected or rejected", async ({ page, request }) => {
  await page.goto("/app/e2e-farm");
  await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fe2e-farm/);
  const api = await request.get("/api/v1/orgs/e2e-farm/aois");
  expect(api.status()).toBe(401);
});

test("signing in through the form works", async ({ page }) => {
  // Accounts created from an email invitation can still sign in with their address.
  await signInWithForm(page, "e2e-city-admin@oryn.local", fx().password, "/app/e2e-city");
  await page.waitForURL(/\/app\/e2e-city$/);
  await expect(page.getByRole("heading", { name: "E2E City (synthetic)" })).toBeVisible();
});

test("wrong password is rejected without revealing which part was wrong", async ({ page }) => {
  await signInWithForm(page, "e2e-analyst@oryn.local", "not-the-password-123");
  await expect(page.getByText("The username or password is incorrect.")).toBeVisible();
});

test("public sign-up without an invitation is refused", async ({ request }) => {
  const r = await request.post("/api/auth/sign-up/email", {
    data: { email: `intruder-${Date.now()}@example.com`, password: "a-long-password-123", name: "Intruder" },
    headers: { Origin: "http://localhost:3000" },
  });
  expect(r.status()).toBe(404);
});

test("a member of one org cannot reach another org's data by URL or guessed id", async ({ page }) => {
  const f = fx();
  await signIn(page, "e2e-city-admin@oryn.local");
  // Org page of another tenant: indistinguishable from a missing org.
  const res = await page.goto("/app/e2e-farm");
  expect(res?.status()).toBe(404);
  // API: other org's slug, and another org's AOI id through this org's endpoint.
  const other = await page.request.get("/api/v1/orgs/e2e-farm/aois");
  expect(other.status()).toBe(404);
  const guessed = await page.request.get(`/api/v1/orgs/e2e-city/aois/${f.farmAoi}`);
  expect(guessed.status()).toBe(404);
  const guessedObs = await page.request.get(`/api/v1/orgs/e2e-city/aois/${f.farmAoi}/observations`);
  expect(guessedObs.status()).toBe(404);
  // Its own data works.
  const own = await page.request.get(`/api/v1/orgs/e2e-city/aois/${f.cityAoi}`);
  expect(own.status()).toBe(200);
});

test("a read-only viewer cannot create areas, in the UI or the API", async ({ page }) => {
  await signIn(page, "e2e-viewer@oryn.local", "/app/e2e-farm/map");
  await page.goto("/app/e2e-farm/map");
  await expect(page.getByText("E2E North field").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Polygon" })).toHaveCount(0);
  const r = await page.request.post("/api/v1/orgs/e2e-farm/aois", {
    data: { name: "x", kind: "field", geometry: { type: "Polygon", coordinates: [[[-77.4, 35.8], [-77.39, 35.8], [-77.39, 35.81], [-77.4, 35.8]]] } },
  });
  expect(r.status()).toBe(403);
});
