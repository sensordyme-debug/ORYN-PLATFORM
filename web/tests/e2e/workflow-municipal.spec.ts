import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { fx, signIn } from "./helpers";

test("municipal monitoring: review a candidate change with evidence, export, and see it audited", async ({ page }) => {
  const f = fx();
  await signIn(page, "e2e-analyst@oryn.local", "/app/e2e-city");
  await page.goto("/app/e2e-city/detections");
  await expect(page.getByRole("heading", { name: "Inspection queue" })).toBeVisible();
  await page.getByRole("link", { name: /E2E vegetation loss/ }).click();
  await expect(page).toHaveURL(new RegExp(`detection=${f.detection}`));
  const panel = page.getByRole("complementary", { name: "Details" });
  await expect(panel.getByText("Candidate change — unverified")).toBeVisible();
  await expect(panel.getByText(/does not by itself establish what happened on the ground/)).toBeVisible();
  await expect(panel.getByText("Evidence: strong")).toBeVisible();
  // Confirming requires a note.
  await panel.getByRole("button", { name: "Confirm" }).click();
  await expect(panel.getByText(/Add a note explaining/)).toBeVisible();
  await panel.getByLabel("Review note").fill("Checked on site: new gravel lot.");
  await panel.getByRole("button", { name: "Confirm" }).click();
  await expect(panel.getByText("Candidate change — verified by analyst")).toBeVisible();

  // Queue a CSV export of observations.
  await page.goto("/app/e2e-city/reports");
  await page.getByLabel("Format").selectOption("csv");
  await page.getByLabel("Contents").selectOption("observations");
  await page.getByRole("button", { name: "Create export" }).click();
  await expect(page.getByText(/Export queued/)).toBeVisible();

  // The administrator sees both actions in the audit trail.
  await signIn(page, "e2e-city-admin@oryn.local", "/app/e2e-city/audit");
  await expect(page.getByRole("cell", { name: "detection.review" }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "export.create" }).first()).toBeVisible();
});

test("upload a GeoJSON boundary and import it as an area", async ({ page }, info) => {
  await signIn(page, "e2e-analyst@oryn.local", "/app/e2e-city/areas/new");
  await page.goto("/app/e2e-city/areas/new");
  mkdirSync(info.outputDir, { recursive: true });
  const file = path.join(info.outputDir, "parcels.geojson");
  writeFileSync(
    file,
    JSON.stringify({
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { name: "Permit 2026-114" }, geometry: { type: "Polygon", coordinates: [[[-77.536, 35.896], [-77.534, 35.896], [-77.534, 35.898], [-77.536, 35.898], [-77.536, 35.896]]] } },
        { type: "Feature", properties: { name: "Broken" }, geometry: { type: "Polygon", coordinates: [[[-77.5, 35.8], [-77.49, 35.8]]] } },
      ],
    }),
  );
  await page.getByLabel("GeoJSON file").setInputFiles(file);
  await expect(page.getByText("1 feature(s) skipped")).toBeVisible();
  await expect(page.getByText("Permit 2026-114")).toBeVisible();
  await page.getByLabel("Import as").selectOption("construction_site");
  await page.getByRole("button", { name: "Import 1 area" }).click();
  await expect(page).toHaveURL(/\/areas$/);
  await expect(page.getByRole("link", { name: "Permit 2026-114" })).toBeVisible();
});
