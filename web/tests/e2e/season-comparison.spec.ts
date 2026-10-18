import { expect, test } from "@playwright/test";
import { fx, signIn } from "./helpers";

/**
 * The Season comparison panel in the Map workspace. The worker does not run
 * in the e2e suite, so this covers the request path: validation messages,
 * starting a comparison, its queued state, and who may start one. Comparison
 * processing and the PDF are covered by tests/integration/comparisons.test.ts.
 */
test("an analyst requests a season comparison; mismatched seasons are explained", async ({ page }) => {
  const f = fx();
  await signIn(page, "e2e-analyst@oryn.local", `/app/e2e-farm/map?aoi=${f.farmAoi}`);
  const panel = page.getByRole("region", { name: "Season comparison" });
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText(/regions of at least 2,000 m²/)).toBeVisible();

  // Different seasons are refused with the reason.
  await panel.getByLabel("Baseline from").fill("2026-03-01");
  await panel.getByLabel("Baseline to").fill("2026-03-31");
  await panel.getByLabel("Comparison from").fill("2026-09-01");
  await panel.getByLabel("Comparison to").fill("2026-09-30");
  await panel.getByRole("button", { name: "Compare seasons" }).click();
  await expect(panel.getByText(/must cover the same season/)).toBeVisible();

  // The same season a year apart is accepted and queued.
  await panel.getByLabel("Baseline from").fill("2025-09-01");
  await panel.getByLabel("Baseline to").fill("2025-09-30");
  await panel.getByRole("button", { name: "Compare seasons" }).click();
  await expect(panel.getByText(/Sep \d{1,2}, 2025.*vs.*2026/).first()).toBeVisible();
  await expect(panel.getByText("Queued").first()).toBeVisible();
});

test("viewers see comparisons but cannot start one", async ({ page }) => {
  const f = fx();
  await signIn(page, "e2e-viewer@oryn.local", `/app/e2e-farm/map?aoi=${f.farmAoi}`);
  const panel = page.getByRole("region", { name: "Season comparison" });
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByRole("button", { name: "Compare seasons" })).toHaveCount(0);
  const r = await page.request.post(`/api/v1/orgs/e2e-farm/aois/${f.farmAoi}/comparisons`, {
    data: { baseline: { from: "2025-09-01", to: "2025-09-30" }, comparison: { from: "2026-09-01", to: "2026-09-30" } },
    headers: { Origin: "http://localhost:3000" },
  });
  expect(r.status()).toBe(403);
});
