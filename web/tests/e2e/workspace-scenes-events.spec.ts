import { expect, test, type Page } from "@playwright/test";
import { PUBLIC_EVENT_LAYERS, type PublicEventsResponse } from "../../src/lib/public-events";
import { fx, signIn } from "./helpers";

const panel = (page: Page) => page.getByRole("complementary", { name: "Details" });

test("saved scenes: save a view with the globe, reopen it, and keep private scenes private", async ({ page, browser }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const f = fx();
  const run = Date.now().toString(36);
  await signIn(page, "e2e-analyst@oryn.local", `/app/e2e-farm/map?aoi=${f.farmAoi}`);
  await expect(panel(page).getByRole("heading", { name: "E2E North field" })).toBeVisible();

  // Globe and an overlay, from the Layers panel.
  await page.getByRole("tab", { name: "Layers" }).click();
  await page.getByRole("radio", { name: /Globe \(3D overview\)/ }).check();
  await page.getByRole("checkbox", { name: /Hydrography \(NHD\)/ }).check();

  await page.getByRole("tab", { name: "Scenes" }).click();
  await page.getByLabel("Scene name").fill(`E2E shared ${run}`);
  await page.getByRole("button", { name: "Save scene" }).click();
  await expect(page.getByRole("button", { name: new RegExp(`^E2E shared ${run}`) })).toBeVisible();
  await page.getByLabel("Scene name").fill(`E2E private ${run}`);
  await page.getByLabel("Who can open this scene").selectOption("private");
  await page.getByRole("button", { name: "Save scene" }).click();
  await expect(page.getByRole("button", { name: new RegExp(`^E2E private ${run}`) })).toBeVisible();

  // A fresh workspace: flat map, nothing selected. Reopening the scene restores the view.
  await page.goto("/app/e2e-farm/map");
  await page.getByRole("tab", { name: "Scenes" }).click();
  await page.getByRole("button", { name: new RegExp(`^E2E shared ${run}`) }).click();
  await expect(panel(page).getByRole("heading", { name: "E2E North field" })).toBeVisible();
  await page.getByRole("tab", { name: "Layers" }).click();
  await expect(page.getByRole("radio", { name: /Globe \(3D overview\)/ })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /Hydrography \(NHD\)/ })).toBeChecked();
  await page.getByRole("radio", { name: /Flat map \(2D\)/ }).check();
  await expect(page.getByRole("application", { name: "Geospatial workspace map" })).toBeVisible();

  // A viewer sees the shared scene but not the private one, and cannot share or delete.
  const viewer = await (await browser.newContext()).newPage();
  await signIn(viewer, "e2e-viewer@oryn.local", "/app/e2e-farm/map");
  await viewer.getByRole("tab", { name: "Scenes" }).click();
  await expect(viewer.getByRole("button", { name: new RegExp(`^E2E shared ${run}`) })).toBeVisible();
  await expect(viewer.getByRole("button", { name: new RegExp(`^E2E private ${run}`) })).toHaveCount(0);
  await expect(viewer.getByLabel("Who can open this scene").locator("option")).toHaveText(["Only me"]);
  await expect(viewer.getByRole("button", { name: `Delete scene E2E shared ${run}` })).toHaveCount(0);
  await viewer.context().close();

  // The author deletes both.
  page.on("dialog", (d) => d.accept());
  await page.getByRole("tab", { name: "Scenes" }).click();
  for (const n of [`E2E shared ${run}`, `E2E private ${run}`]) {
    await page.getByRole("button", { name: `Delete scene ${n}` }).click();
    await expect(page.getByRole("button", { name: new RegExp(`^${n}`) })).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test("public events: inspect an earthquake near a field, record it, and survive a provider outage", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const retrievedAt = new Date(Date.now() - 120_000).toISOString();
  const quakes: PublicEventsResponse = {
    layer: PUBLIC_EVENT_LAYERS["usgs-earthquakes"],
    feed: { state: "nominal", retrievedAt, generatedAt: retrievedAt, message: null, retryAfterSeconds: null },
    total: 1,
    features: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-77.44, 35.86] },
          properties: {
            layer: "usgs-earthquakes", id: "e2e0001", title: "M 3.4 - 5 km NE of Test", magnitude: 3.4, magnitudeType: "mb", depthKm: 7.5,
            place: "5 km NE of Test", observedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), updatedAt: null, reviewStatus: "reviewed",
            eventType: "earthquake", tsunamiFlag: false, url: "https://earthquake.usgs.gov/earthquakes/eventpage/e2e0001",
          },
        },
      ],
    },
  };
  const fireDown: PublicEventsResponse = {
    layer: PUBLIC_EVENT_LAYERS["nifc-wildfire-perimeters"],
    feed: { state: "unavailable", retrievedAt: null, generatedAt: null, message: "National Interagency Fire Center (WFIGS) is not available right now (HTTP 503).", retryAfterSeconds: 60 },
    total: 0,
    features: { type: "FeatureCollection", features: [] },
  };
  // The browser's calls to ORYN are answered from fixtures: the test never depends on USGS or NIFC being up.
  await page.route("**/api/v1/orgs/e2e-farm/public-events/usgs-earthquakes?*", (r) => r.fulfill({ json: quakes }));
  await page.route("**/api/v1/orgs/e2e-farm/public-events/nifc-wildfire-perimeters?*", (r) => r.fulfill({ json: fireDown }));

  await signIn(page, "e2e-analyst@oryn.local", "/app/e2e-farm/map");
  await page.getByRole("tab", { name: "Layers" }).click();
  await page.getByRole("checkbox", { name: /Earthquakes \(M2\.5\+\)/ }).check();
  await page.getByRole("checkbox", { name: /Wildfire perimeters/ }).check();
  await expect(page.getByText("Current", { exact: true })).toBeVisible();
  await expect(page.getByText("Unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText(/WFIGS\) is not available right now/)).toBeVisible();

  await page.getByRole("list", { name: /Earthquakes \(M2\.5\+\) in view/ }).getByRole("button", { name: /M3\.4/ }).click();
  const card = panel(page);
  await expect(card.getByRole("heading", { name: "M 3.4 - 5 km NE of Test" })).toBeVisible();
  await expect(card.getByText("Reviewed by USGS")).toBeVisible();
  await expect(card.getByText("Origin time")).toBeVisible();
  await expect(card.getByText("Retrieved by ORYN")).toBeVisible();
  await expect(card.getByText("Public domain (U.S. Government work)")).toBeVisible();
  await expect(card.getByRole("button", { name: /E2E North field/ })).toBeVisible();
  await card.getByRole("button", { name: "Add note" }).first().click();
  await expect(card.getByText(/Recorded on “E2E North field” as a note/)).toBeVisible();

  // The outage did not affect the rest of the workspace.
  await page.getByRole("tab", { name: "Areas" }).click();
  await page.locator("aside").getByRole("button", { name: /E2E North field/ }).first().click();
  await expect(panel(page).getByRole("heading", { name: "E2E North field" })).toBeVisible();
  // The note is on the area, labelled as a public record.
  await expect(panel(page).getByText(/Public record \(not an ORYN finding\): USGS reports M 3\.4/).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("scenes and public events require membership", async ({ page, request }) => {
  for (const path of ["/api/v1/orgs/e2e-farm/scenes", "/api/v1/orgs/e2e-farm/public-events/usgs-earthquakes?bbox=-80,30,-70,40"]) {
    expect((await request.get(path)).status()).toBe(401);
  }
  await signIn(page, "e2e-viewer@oryn.local", "/app/e2e-farm");
  // A member of one organization cannot read another's scenes.
  const res = await page.request.get("/api/v1/orgs/e2e-city/scenes");
  expect([403, 404]).toContain(res.status());
  // Viewers may save private scenes only.
  const shared = await page.request.post("/api/v1/orgs/e2e-farm/scenes", { data: { name: "nope", visibility: "org", state: { view: { center: [-77, 35], zoom: 8 } } } });
  expect(shared.status()).toBe(403);
  const invalid = await page.request.get("/api/v1/orgs/e2e-farm/public-events/usgs-earthquakes?bbox=0,0,999,1");
  expect(invalid.status()).toBe(422);
});
