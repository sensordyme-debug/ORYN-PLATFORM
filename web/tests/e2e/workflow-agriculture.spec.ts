import { expect, test } from "@playwright/test";
import { fx, mapClick, signIn } from "./helpers";

test("agricultural monitoring: draw a field, configure it, and add an alert rule", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await signIn(page, "e2e-analyst@oryn.local", "/app/e2e-farm");
  await page.goto("/app/e2e-farm");
  await expect(page.getByRole("heading", { name: "E2E Farm (synthetic)" })).toBeVisible();
  await expect(page.getByText(/Synthetic development organization/)).toBeVisible();

  // Draw a field on the map.
  await page.goto("/app/e2e-farm/map");
  await page.getByRole("button", { name: "Polygon" }).click();
  const map = page.getByRole("application", { name: "Geospatial workspace map" });
  await expect(map).toBeVisible();
  await page.waitForTimeout(1500);
  const box = (await map.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  for (const [dx, dy] of [[-60, -60], [60, -60], [60, 60], [-60, 60], [-60, -60]] as const) await mapClick(page, cx + dx, cy + dy);
  await expect(page.getByText("New area of interest")).toBeVisible();
  await page.getByLabel("Name").fill("E2E drawn field");
  await page.getByLabel("Crop (optional)").fill("cotton");
  await page.getByRole("button", { name: "Save and start monitoring" }).click();
  await expect(page.getByText(/“E2E drawn field” saved/)).toBeVisible();
  await expect(page.locator("aside").getByText("E2E drawn field").first()).toBeVisible();

  // It persists and is configurable.
  await page.goto("/app/e2e-farm/areas");
  await page.getByRole("link", { name: "E2E drawn field" }).click();
  await expect(page.getByText("Boundary source")).toBeVisible();
  await page.getByLabel("Check every (hours)").fill("6");
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect(page.getByText(/Saved\./)).toBeVisible();

  // Configure an alert rule.
  await page.goto("/app/e2e-farm/alerts/rules");
  await page.getByLabel("Rule type").selectOption("ndvi_drop_vs_baseline");
  await page.getByLabel("Name").fill("E2E NDVI drop");
  await page.getByRole("button", { name: "Create rule" }).click();
  await expect(page.getByText("Rule created.")).toBeVisible();
  await expect(page.getByRole("cell", { name: /E2E NDVI drop/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("agricultural monitoring: inspect a within-field low-vigour zone", async ({ page }) => {
  const f = fx();
  await signIn(page, "e2e-analyst@oryn.local", "/app/e2e-farm");
  await page.goto(`/app/e2e-farm/map?detection=${f.zone}`);
  const panel = page.getByRole("complementary", { name: "Details" });
  await expect(panel.getByRole("heading", { name: /E2E low-vigour zone #1/ })).toBeVisible();
  // A measurement relative to the rest of the field, explicitly not a diagnosis.
  await expect(panel.getByText(/That is a\s+measurement, not a diagnosis/)).toBeVisible();
  await expect(panel.getByText("Area median NDVI")).toBeVisible();
  await expect(panel.getByText(/0\.27 NDVI \(33% below the median\)/)).toBeVisible();
  await expect(panel.getByText("Edge on area boundary")).toBeVisible();
  await expect(panel.getByText("No earlier usable image within 45 days to check persistence.").first()).toBeVisible();
  await expect(panel.getByRole("button", { name: "Show NDVI" })).toBeVisible();
  await expect(panel.getByText("Evidence: strong")).toBeVisible();
  // With no satellite image displayed, the historical basemap says what it is.
  await expect(page.getByRole("note").filter({ hasText: "a mosaic of varying dates, not current conditions" })).toBeVisible();
  // The layer legend lists zones with their own (dashed) symbol and label.
  await page.getByRole("tab", { name: "Layers" }).click();
  await expect(page.getByText("Low-vigour zone (within-field, one date)")).toBeVisible();
});
