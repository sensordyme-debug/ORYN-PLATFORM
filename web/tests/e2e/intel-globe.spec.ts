import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * The Intelligence globe runs on the God's Eye View geospatial engine (served
 * same-origin under /engine/ by `npm run oryn:engine` in ORYN-PLATFORM). The
 * engine's request to USGS is answered from a fixture, so this test never
 * depends on the live feed; ORYN's own records come from the seeded e2e
 * fixtures through the permission-checked API.
 */
const USGS_FEED = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson";

async function mockEngineFeeds(page: Page) {
  const now = Date.now();
  await page.route(USGS_FEED, (r) =>
    r.fulfill({
      json: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            id: "e2eglobe1",
            geometry: { type: "Point", coordinates: [-77.44, 35.86, 9.1] },
            properties: { mag: 3.1, place: "4 km E of Globe Test", time: now - 3 * 3_600_000 },
          },
        ],
      },
    }),
  );
}

const engineState = (page: Page) =>
  page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Intelligence globe"]');
    const host = (frame?.contentWindow as (Window & { __gevHost?: { status(): { state: string } } }) | null)?.__gevHost;
    return host?.status().state ?? null;
  });

test("intelligence globe: God's Eye View engine inside the ORYN workspace, honest feed states, ORYN records, and the switch to 2D", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => /Content Security Policy|Refused to/i.test(m.text()) && errors.push(m.text()));
  await mockEngineFeeds(page);
  await signIn(page, "e2e-analyst@oryn.local", "/app/e2e-farm/intel");
  await expect(page.getByRole("link", { name: "Intelligence globe" })).toBeVisible();

  // The real engine starts in its own same-origin document and renders the globe.
  await expect.poll(() => engineState(page), { timeout: 120_000 }).toBe("ready");
  await expect(page.frameLocator('iframe[title="Intelligence globe"]').locator("#cesiumContainer canvas").first()).toBeVisible();

  // ORYN's own records are listed with their state.
  await expect(page.locator("label").filter({ hasText: "Areas of interest" }).getByText("Current", { exact: true })).toBeVisible();

  // A mode turns on engine layers; each row says what state it is in and what it holds.
  await page.getByRole("button", { name: /Global intelligence/ }).click();
  const quakeRow = page.locator("label").filter({ hasText: "Earthquakes (24h)" });
  await expect(quakeRow.getByText("Current", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(quakeRow.getByText(/1 shown · retrieved/)).toBeVisible();
  await expect(quakeRow.getByText("USGS")).toBeVisible();
  // Layers whose licences do not permit commercial display are not offered.
  const withheld = page.locator("details").filter({ hasText: "engine layers not offered in ORYN" });
  await expect(withheld).toBeVisible();
  await withheld.locator("summary").click();
  await expect(withheld.getByText(/Submarine Cables/)).toBeVisible();
  await expect(withheld.getByText(/CC BY-NC-SA/)).toBeVisible();
  await expect(page.locator("aside label").filter({ hasText: "Street Traffic" })).toHaveCount(0);

  // Search reaches records loaded in the engine; the card shows provenance and times.
  await page.getByLabel(/Search areas, findings/).fill("Globe Test");
  await page.getByRole("list", { name: "Search results" }).getByRole("button", { name: /M3\.1 4 km E of Globe Test/ }).click();
  const card = page.getByRole("complementary", { name: "Details" });
  await expect(card.getByRole("heading", { name: "M3.1 4 km E of Globe Test" })).toBeVisible();
  // Earthquakes are observations; the card says so, with the USGS licence.
  await expect(card.getByText("Provider-reported observation", { exact: true })).toBeVisible();
  await expect(card.getByText(/U.S. Geological Survey (U.S. public domain)/)).toBeVisible();
  await expect(card.getByText("Retrieved by ORYN")).toBeVisible();

  // One click to the existing 2D map at the same place, and back.
  await page.getByRole("link", { name: "2D map workspace" }).click();
  await expect(page).toHaveURL(/\/app\/e2e-farm\/map/);
  await expect(page.getByRole("application", { name: "Geospatial workspace map" })).toBeVisible();
  await expect(page.getByRole("link", { name: "3D intelligence globe" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("the geospatial engine is reachable only with an ORYN session", async ({ request }) => {
  for (const path of ["/engine/index.html?host=oryn", "/engine/cesium/Cesium.js", "/api/cctv/sources", "/api/terrain/heights"]) {
    expect((await request.get(path)).status()).toBe(401);
  }
  expect((await request.get("/engine/index.html?host=oryn", { headers: { Cookie: "oryn.session_token=forged.value" } })).status()).toBe(401);
  // Engine routes that write configuration or start paid sessions are never forwarded.
  for (const path of ["/api/setup/status", "/api/openai/hud-summary", "/api/realtime/token"]) {
    expect((await request.get(path)).status()).toBe(404);
  }
});

test("intelligence APIs require membership and check area access", async ({ page, request }) => {
  for (const path of [
    "/api/v1/orgs/e2e-farm/intel/satellites",
    "/api/v1/orgs/e2e-farm/intel/satellites/passes?lon=-77&lat=35",
    "/api/v1/orgs/e2e-farm/intel/cameras?bbox=-125,32,-114,42",
    "/api/v1/orgs/e2e-farm/intel/cameras/caltrans-cctv:7:1/health",
  ]) {
    expect((await request.get(path)).status()).toBe(401);
  }
  await signIn(page, "e2e-viewer@oryn.local", "/app/e2e-farm");
  // A viewer of one organization cannot ask about another organization's area.
  expect([403, 404]).toContain((await page.request.get("/api/v1/orgs/e2e-city/intel/satellites/passes?aoi=00000000-0000-4000-8000-000000000000")).status());
  expect((await page.request.get("/api/v1/orgs/e2e-farm/intel/satellites/passes?aoi=00000000-0000-4000-8000-000000000000")).status()).toBe(404);
  expect((await page.request.get("/api/v1/orgs/e2e-farm/intel/satellites?at=2020-01-01T00:00:00Z")).status()).toBe(422);
  expect((await page.request.get("/api/v1/orgs/e2e-farm/intel/cameras?bbox=0,0,999,1")).status()).toBe(422);
});
