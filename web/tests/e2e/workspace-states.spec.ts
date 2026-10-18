import { expect, test } from "@playwright/test";
import { fx, signIn } from "./helpers";

/**
 * Missing and unavailable records stay inside the workspace (they used to be
 * server errors that dropped the navigation), without saying whether the
 * record exists elsewhere. Non-members still get the site's plain 404.
 */
test("a missing or unavailable record is explained inside the workspace", async ({ page }) => {
  const f = fx();
  await signIn(page, "e2e-city-admin@oryn.local", "/app/e2e-city");
  const nav = page.getByRole("navigation").getByRole("link", { name: "Map workspace" });

  // A missing report, a malformed alert id, and another organization's area id all read the same.
  for (const path of ["/app/e2e-city/reports/00000000-0000-4000-8000-000000000000", "/app/e2e-city/alerts/not-a-uuid", `/app/e2e-city/areas/${f.farmAoi}`]) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBeLessThan(500);
    await expect(page.getByText("This record isn't available"), path).toBeVisible();
    await expect(nav, path).toBeVisible();
  }
  await page.getByRole("link", { name: "Go to the overview" }).click();
  await expect(page).toHaveURL(/\/app\/e2e-city$/);

  // Not a member: the site's 404, no workspace shell.
  const other = await page.goto("/app/e2e-farm/reports/00000000-0000-4000-8000-000000000000");
  expect(other?.status()).toBe(404);
  await expect(nav).toHaveCount(0);
});

test("a GeoJSON file chosen before the page finished loading is still read", async ({ page }) => {
  await signIn(page, "e2e-analyst@oryn.local", "/app/e2e-city");
  const geojson = JSON.stringify({
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { name: "Chosen before hydration" }, geometry: { type: "Polygon", coordinates: [[[-77.53, 35.89], [-77.528, 35.89], [-77.528, 35.892], [-77.53, 35.892], [-77.53, 35.89]]] } }],
  });
  // Choose the file the moment the server-rendered input is inserted, before
  // React hydrates it (so no change event reaches the component).
  await page.addInitScript((text) => {
    new MutationObserver((_, observer) => {
      const input = document.querySelector<HTMLInputElement>('input[type="file"][aria-label="GeoJSON file"]');
      if (!input) return;
      observer.disconnect();
      const dt = new DataTransfer();
      dt.items.add(new File([text], "early.geojson", { type: "application/geo+json" }));
      input.files = dt.files;
      (window as unknown as { earlyFileSet?: boolean }).earlyFileSet = true;
    }).observe(document, { childList: true, subtree: true });
  }, geojson);
  await page.goto("/app/e2e-city/areas/new");
  await expect.poll(() => page.evaluate(() => (window as unknown as { earlyFileSet?: boolean }).earlyFileSet === true)).toBe(true);
  await expect(page.getByText("Chosen before hydration")).toBeVisible();
});

test("wide tables can be scrolled from the keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "e2e-city-admin@oryn.local", "/app/e2e-city/areas");
  const table = page.getByRole("region", { name: "Areas" });
  await expect(table).toBeVisible();
  await table.focus();
  await expect(table).toBeFocused();
  // The areas table is wider than a phone; arrow keys scroll it (smoothly, so poll).
  expect(await table.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => table.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
});
