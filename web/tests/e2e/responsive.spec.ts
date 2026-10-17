import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("the workspace is usable at tablet width", async ({ page }) => {
  await signIn(page, "e2e-analyst@oryn.local", "/app/e2e-city/map");
  await page.goto("/app/e2e-city/map");
  await expect(page.getByRole("application", { name: "Geospatial workspace map" })).toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("link", { name: "Inspection queue" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
