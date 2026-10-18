import { expect, test } from "@playwright/test";
import { fx, signIn } from "./helpers";

/**
 * The crop water balance in the Map workspace. The e2e database holds no
 * daily weather for the field, so after the inputs are saved the panel must
 * say the estimate is missing weather — never show a number.
 */
test("an analyst adds field details; without daily weather the water balance names what is missing", async ({ page }) => {
  const f = fx();
  await signIn(page, "e2e-analyst@oryn.local", `/app/e2e-farm/map?aoi=${f.farmAoi}`);
  const panel = page.getByRole("region", { name: "Crop water balance" });
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await panel.getByRole("button", { name: /field details/ }).click();
  const form = panel.getByRole("form", { name: "Field details for the water balance" });
  await form.getByLabel("Crop").selectOption("soybeans");
  await form.getByLabel("Planting date").fill("2026-05-01");
  await form.getByLabel("Soil texture").selectOption("loam");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);
  await expect(panel.getByText(/No estimate: .* days since planting lack ETo or rainfall/)).toBeVisible();
  await expect(panel.getByText(/Depletion \d/)).toHaveCount(0);
  await panel.getByText("Inputs, sources and limitations").click();
  await expect(panel.getByText(/Soybeans — Field agronomy inputs/)).toBeVisible();
  await expect(panel.getByText(/FAO-56 Table 19, typical loam/)).toBeVisible();
});

test("a viewer sees the water balance but cannot change the field details or log irrigation", async ({ page }) => {
  const f = fx();
  await signIn(page, "e2e-viewer@oryn.local", `/app/e2e-farm/map?aoi=${f.farmAoi}`);
  const panel = page.getByRole("region", { name: "Crop water balance" });
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByRole("button", { name: /field details/ })).toHaveCount(0);
  await expect(panel.getByRole("form", { name: "Log irrigation" })).toHaveCount(0);
  const put = await page.request.put(`/api/v1/orgs/e2e-farm/aois/${f.farmAoi}/agronomy`, {
    data: { crop: "cotton", plantingDate: "2026-05-01", stageDays: null, soilTexture: "loam", availableWaterMmPerM: null, rootDepthM: null, notes: "" },
    headers: { Origin: "http://localhost:3000" },
  });
  expect(put.status()).toBe(403);
});
