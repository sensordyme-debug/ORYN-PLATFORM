import { expect, test, type Browser } from "@playwright/test";
import { clearSignInRateLimit, fx, signIn, signInWithForm } from "./helpers";

test.beforeEach(clearSignInRateLimit);

const NEW_PASSWORD = "a-partner-chosen-passphrase-7";
const GENERIC_FAILURE = "The username or password is incorrect.";

test("the sign-in page offers no public registration", async ({ page, request }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in to ORYN" })).toBeVisible();
  await expect(page.getByText("There is no public sign-up.")).toBeVisible();
  await expect(page.getByRole("link", { name: /sign up|create account|register/i })).toHaveCount(0);
  for (const path of ["/api/auth/sign-up/email", "/api/auth/is-username-available", "/api/auth/update-user", "/api/auth/change-password"]) {
    const r = await request.post(path, { data: { email: "x@example.com", username: "x", password: "a-long-password-1", name: "X" }, headers: { Origin: "http://localhost:3000" } });
    expect(r.status(), path).toBe(404);
  }
});

test("the trial account signs in with its username and sees only the trial workspace", async ({ page }) => {
  // Mixed case on purpose: usernames are case-insensitive.
  await signInWithForm(page, "E2E_TRIAL", fx().password);
  await page.waitForURL(/\/app\/e2e-trial$/);
  await expect(page.getByText("Trial workspace. Areas and records here are synthetic sample data")).toBeVisible();
  await expect(page.getByText("shared trial account")).toBeVisible();
  await page.goto("/app/e2e-trial/map");
  await expect(page.getByText("E2E Trial field").first()).toBeVisible();
  // Read-only trial: no drawing tools, and the API refuses writes.
  await expect(page.getByRole("button", { name: "Polygon" })).toHaveCount(0);
  const write = await page.request.post("/api/v1/orgs/e2e-trial/aois", {
    data: { name: "x", kind: "field", geometry: { type: "Polygon", coordinates: [[[-77.4, 35.8], [-77.39, 35.8], [-77.39, 35.81], [-77.4, 35.8]]] } },
  });
  expect(write.status()).toBe(403);
  // Real partner data is unreachable — same answer as a missing organization.
  expect((await page.goto("/app/e2e-city"))?.status()).toBe(404);
  expect((await page.request.get(`/api/v1/orgs/e2e-city/aois/${fx().cityAoi}`)).status()).toBe(404);
  expect((await page.request.get("/api/v1/orgs/e2e-farm/aois")).status()).toBe(404);
});

test("a partner must replace the issued password before the workspace opens", async ({ page }) => {
  await signInWithForm(page, "e2e_partner", fx().password);
  await page.waitForURL(/\/app\/account\?required=1/);
  await expect(page.getByText("Choose a new password to continue")).toBeVisible();
  // The organization and its API stay closed meanwhile.
  await page.goto("/app/e2e-city");
  await expect(page).toHaveURL(/\/app\/account\?required=1&next=%2Fapp%2Fe2e-city/);
  const api = await page.request.get("/api/v1/orgs/e2e-city/aois");
  expect(api.status()).toBe(403);
  expect((await api.json()).error.code).toBe("password_change_required");

  await page.getByLabel("Current password").fill(fx().password);
  await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Change password" }).click();
  await page.waitForURL(/\/app\/e2e-city$/);
  await expect(page.getByRole("heading", { name: "E2E City (synthetic)" })).toBeVisible();
  expect((await page.request.get("/api/v1/orgs/e2e-city/aois")).status()).toBe(200);
  // The issued password no longer works.
  await page.context().clearCookies();
  await clearSignInRateLimit();
  await signInWithForm(page, "e2e_partner", fx().password);
  await expect(page.getByText(GENERIC_FAILURE)).toBeVisible();
});

test("disabled accounts and unknown usernames get the same answer as a wrong password", async ({ page }) => {
  for (const [username, password] of [["e2e_disabled", fx().password], ["no_such_user", fx().password], ["e2e_trial", "not-the-password-123"]]) {
    await signInWithForm(page, username!, password!);
    await expect(page.getByText(GENERIC_FAILURE)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  }
});

test("account pages require a session, and account administration requires a platform administrator", async ({ page }) => {
  await page.goto("/app/account");
  await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Faccount/);
  await page.goto("/app/admin/accounts");
  await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fadmin%2Faccounts/);
  await signIn(page, "e2e-city-admin@oryn.local", "/app/admin/accounts");
  expect((await page.goto("/app/admin/accounts"))?.status()).toBe(404);
});

async function freshPage(browser: Browser) {
  const ctx = await browser.newContext();
  return { ctx, page: await ctx.newPage() };
}

test("a platform administrator issues a partner account that works end to end", async ({ page, browser }) => {
  const username = `e2e_ui_${Date.now().toString(36)}`;
  await signIn(page, "e2e-admin@oryn.local", "/app/admin/accounts");
  await page.goto("/app/admin/accounts");
  await expect(page.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible();
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Create account" }) });
  await form.getByLabel("Username").fill(username);
  await form.getByLabel("Name", { exact: true }).fill("E2E UI Partner");
  await form.getByLabel("Organization").selectOption("e2e-city");
  await expect(form.getByLabel("Role")).toHaveValue("viewer");
  await form.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText(`Created ${username}`)).toBeVisible();
  const temporary = await form.getByLabel("Value to copy").inputValue();
  expect(temporary).toMatch(/^[A-Za-z0-9_-]{24}$/);
  await expect(page.getByRole("cell", { name: new RegExp(username) })).toBeVisible();

  // The partner, in a separate browser: sign in → forced change → workspace.
  const partner = await freshPage(browser);
  await signInWithForm(partner.page, username, temporary);
  await partner.page.waitForURL(/\/app\/account\?required=1/);
  await partner.page.getByLabel("Current password").fill(temporary);
  await partner.page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await partner.page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
  await partner.page.getByRole("button", { name: "Change password" }).click();
  await partner.page.waitForURL(/\/app\/e2e-city$/);
  await expect(partner.page.getByRole("heading", { name: "E2E City (synthetic)" })).toBeVisible();

  // Disabling ends the partner's session at once.
  await page.reload();
  const row = page.getByRole("row", { name: new RegExp(username) });
  await row.getByText("Manage").click();
  page.once("dialog", (d) => d.accept("e2e: contract ended"));
  await row.getByRole("button", { name: "Disable" }).click();
  await expect(row.getByText(/Disabled; 1 session\(s\)/)).toBeVisible();
  await partner.page.reload();
  await expect(partner.page).toHaveURL(/\/login/);
  const api = await partner.page.request.get("/api/v1/orgs/e2e-city/aois");
  expect(api.status()).toBe(401);
  await partner.ctx.close();
});
