import { expect, test, type Page } from "@playwright/test";
import { CAMERA_PROVIDERS, NO_CAMERA_ANALYTICS, type CamerasResponse, type StreamHealth } from "../../src/lib/intel/cameras";
import { IMAGING_SATELLITES, type SatelliteTracksResponse } from "../../src/lib/intel/satellites";
import { PUBLIC_EVENT_LAYERS, type PublicEventsResponse } from "../../src/lib/public-events";
import { signIn } from "./helpers";

/**
 * The browser's calls to ORYN's intelligence APIs are answered from fixtures,
 * so these tests never depend on USGS, NIFC, CelesTrak, or Caltrans. (The
 * real sources are covered by unit tests with recorded data and by
 * `oryn:verify`.) Requires the gated layers to be enabled on the server under
 * test: dev mode, or ORYN_VERIFIED_INTEGRATIONS in a production rehearsal.
 */
async function mockIntel(page: Page) {
  const now = Date.now();
  const retrievedAt = new Date(now - 60_000).toISOString();
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
            layer: "usgs-earthquakes", id: "e2eglobe1", title: "M 3.1 - 4 km E of Globe Test", magnitude: 3.1, magnitudeType: "mb", depthKm: 9.1,
            place: "4 km E of Globe Test", observedAt: new Date(now - 3 * 3_600_000).toISOString(), updatedAt: null, reviewStatus: "automatic",
            eventType: "earthquake", tsunamiFlag: false, url: null,
          },
        },
      ],
    },
  };
  const firesDown: PublicEventsResponse = {
    layer: PUBLIC_EVENT_LAYERS["nifc-wildfire-perimeters"],
    feed: { state: "unavailable", retrievedAt: null, generatedAt: null, message: "National Interagency Fire Center (WFIGS) did not respond in time.", retryAfterSeconds: 60 },
    total: 0,
    features: { type: "FeatureCollection", features: [] },
  };
  const samples: [number, number, number, number][] = [];
  for (let i = -100; i <= 100; i++) samples.push([now + i * 30_000, -80 + i * 0.02, i * 0.33, 790_000]);
  const sats: SatelliteTracksResponse = {
    feed: { state: "nominal", retrievedAt, message: null },
    at: new Date(now).toISOString(),
    halfWindowMinutes: 50,
    stepSeconds: 30,
    satellites: IMAGING_SATELLITES.map((s) => ({
      ...s,
      track: s.name === "Sentinel-2B" ? { noradId: s.noradId, name: s.name, elementsEpoch: new Date(now - 5 * 3_600_000).toISOString(), elementsAgeHours: 5, samples } : null,
    })),
  };
  const cams: CamerasResponse = {
    provider: CAMERA_PROVIDERS["caltrans-cctv"],
    feed: { state: "nominal", retrievedAt, message: null },
    analytics: NO_CAMERA_ANALYTICS,
    total: 1,
    cameras: [
      {
        id: "caltrans-cctv:7:999", provider: "caltrans-cctv", name: "I-5 : (999) E2E Test Overcrossing", lon: -118.25, lat: 34.06, route: "I-5", direction: "North", nearby: "Test City", district: "D7",
        still: { url: "https://cwwp2.dot.ca.gov/data/d7/cctv/image/e2etest/e2etest.jpg", refreshMinutes: 2 },
        video: { hls: "https://wzmedia.dot.ca.gov/D7/CCTV-999.stream/playlist.m3u8" },
      },
    ],
  };
  const offline: StreamHealth = { cameraId: "caltrans-cctv:7:999", status: "offline", httpStatus: 404, checkedAt: new Date(now).toISOString(), message: "Caltrans lists this camera, but its live stream is offline right now (HTTP 404). The still image may still update." };
  await page.route("**/api/v1/orgs/e2e-farm/public-events/usgs-earthquakes?*", (r) => r.fulfill({ json: quakes }));
  await page.route("**/api/v1/orgs/e2e-farm/public-events/nifc-wildfire-perimeters?*", (r) => r.fulfill({ json: firesDown }));
  await page.route("**/api/v1/orgs/e2e-farm/intel/satellites?*", (r) => r.fulfill({ json: sats }));
  await page.route("**/api/v1/orgs/e2e-farm/intel/cameras?*", (r) => r.fulfill({ json: cams }));
  await page.route("**/api/v1/orgs/e2e-farm/intel/cameras/*/health", (r) => r.fulfill({ json: offline }));
  // The camera still comes straight from Caltrans in production; here a 1×1 image with a capture time.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
  await page.route("https://cwwp2.dot.ca.gov/**", (r) => r.fulfill({ status: 200, body: png, headers: { "content-type": "image/png", "last-modified": new Date(now - 90_000).toUTCString(), "access-control-allow-origin": "*" } }));
}

test("intelligence globe: real 3D view, honest feed states, entity cards, and the switch to 2D", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => /Content Security Policy|Refused to/i.test(m.text()) && errors.push(m.text()));
  await mockIntel(page);
  await signIn(page, "e2e-analyst@oryn.local", "/app/e2e-farm/intel");
  await expect(page.getByRole("link", { name: "Intelligence globe" })).toBeVisible();
  const globe = page.getByRole("application", { name: "3D intelligence globe" });
  await expect(globe.locator("canvas")).toBeVisible({ timeout: 60_000 });

  // A mode turns on only implemented, available layers; each says what state it is in.
  await page.getByRole("button", { name: /Global intelligence/ }).click();
  const quakeRow = page.locator("label").filter({ hasText: "Earthquakes (M2.5+)" });
  await expect(quakeRow.getByText("Current", { exact: true })).toBeVisible();
  await expect(quakeRow.getByText(/1 in the 7 days before the shown time/)).toBeVisible();
  const fireRow = page.locator("label").filter({ hasText: "Wildfire perimeters (current, US)" });
  await expect(fireRow.getByText("Unavailable", { exact: true })).toBeVisible();
  await expect(fireRow.getByText(/did not respond in time/)).toBeVisible();

  // Satellites: computed positions, labelled as such.
  await page.getByRole("list", { name: "Imaging satellites" }).getByRole("button", { name: /Sentinel-2B/ }).click();
  const card = page.getByRole("complementary", { name: "Details" });
  await expect(card.getByRole("heading", { name: "Sentinel-2B" })).toBeVisible();
  await expect(card.getByText("Computed position — not observed")).toBeVisible();
  await expect(card.getByText(/290 km \(shaded on the globe\)/)).toBeVisible();

  // Search reaches public events; the shared event card shows source and times.
  await page.getByLabel(/Search areas, findings/).fill("Globe Test");
  await page.getByRole("list", { name: "Search results" }).getByRole("button", { name: /M 3\.1/ }).click();
  await expect(card.getByRole("heading", { name: "M 3.1 - 4 km E of Globe Test" })).toBeVisible();
  await expect(card.getByText("Automatic solution", { exact: true })).toBeVisible();
  await expect(card.getByText("Retrieved by ORYN")).toBeVisible();

  // Cameras: a still labelled as a still with its capture time; an offline stream is not presented as live.
  await page.getByRole("button", { name: /Traffic and cameras/ }).click();
  await page.getByLabel(/Search areas, findings/).fill("E2E Test Overcrossing");
  await page.getByRole("list", { name: "Search results" }).getByRole("button", { name: /E2E Test Overcrossing/ }).click();
  await expect(card.getByRole("heading", { name: "I-5 : (999) E2E Test Overcrossing" })).toBeVisible();
  await expect(card.getByText(/Still image — captured/)).toBeVisible();
  await expect(card.getByLabel("Stream status")).toContainText("Stream offline");
  await expect(card.getByRole("button", { name: "Play live video" })).toBeDisabled();
  await expect(card.getByText(/No computer vision runs on this camera/)).toBeVisible();

  // The timeline starts live, in real time.
  await expect(page.getByLabel("Timeline").getByRole("button", { name: "Live", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("slider", { name: "Shown time" })).toBeVisible();

  // One click to the existing 2D map at the same place, and back.
  await page.getByRole("link", { name: "2D map workspace" }).click();
  await expect(page).toHaveURL(/\/app\/e2e-farm\/map/);
  await expect(page.getByRole("application", { name: "Geospatial workspace map" })).toBeVisible();
  await expect(page.getByRole("link", { name: "3D intelligence globe" })).toBeVisible();
  expect(errors).toEqual([]);
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
