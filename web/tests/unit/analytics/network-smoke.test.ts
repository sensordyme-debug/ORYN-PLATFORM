/**
 * Optional smoke test against real Earth Search Sentinel-2 L2A COGs around
 * Tarboro, NC. Runs only with ORYN_NETWORK_TESTS=1.
 */
import { describe, expect, it } from "vitest";
import type { PolygonGeometry as Polygon } from "@/lib/geo";
import type { AssetFile } from "@/server/providers/types";
import { analyzeOptical } from "@/server/analytics/analyze";
import { clearCogCache, readToGrid } from "@/server/analytics/raster/cog";

const RUN = process.env.ORYN_NETWORK_TESTS === "1";
const ITEM = "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/18/S/TE/2026/10/S2C_18STE_20261006_0_L2A";
// As published by the item (processing baseline 05.13, earthsearch:boa_offset_applied = true).
const REFL = { scale: 0.0001, offset: -0.1, nodata: 0, dataType: "uint16" };
const ASSETS: Record<string, AssetFile> = {
  red: { href: `${ITEM}/B04.tif`, bands: [REFL] },
  nir: { href: `${ITEM}/B08.tif`, bands: [REFL] },
  green: { href: `${ITEM}/B03.tif`, bands: [REFL] },
  scl: { href: `${ITEM}/SCL.tif`, bands: [{ nodata: 0, dataType: "uint8" }] },
};
const [LON, LAT] = [-77.5358, 35.8968];
const D_LON = 0.0028; // ≈ 250 m
const D_LAT = 0.00225; // ≈ 250 m
const AOI: Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [LON - D_LON, LAT - D_LAT],
      [LON + D_LON, LAT - D_LAT],
      [LON + D_LON, LAT + D_LAT],
      [LON - D_LON, LAT + D_LAT],
      [LON - D_LON, LAT - D_LAT],
    ],
  ],
};

describe("network smoke test (Earth Search Sentinel-2)", () => {
  it.skipIf(!RUN)(
    "computes a plausible NDVI for a 500 m box around Tarboro from B04/B08/SCL",
    async () => {
      clearCogCache();
      const started = Date.now();
      const params = {
        collection: "sentinel-2-l2a" as const,
        assets: ASSETS,
        aoi: AOI,
        resolve: async (key: string) => ({ url: ASSETS[key]!.href }),
        sceneCloudCover: 0.03,
        want: { ndvi: true, ndwi: true, trueColor: false },
      };
      // This item has earthsearch:boa_offset_applied = true but still publishes offset −0.1;
      // applying it again yields impossible negative reflectance, which the engine refuses.
      await expect(analyzeOptical(params)).rejects.toMatchObject({ reason: "implausible_reflectance" });
      const res = await analyzeOptical({ ...params, boaOffsetApplied: true });
      const ndvi = res.ndvi!;
      // Raw red DN for a direct read of the same grid (harmonized: reflectance × 10 000).
      const red = await readToGrid({ url: ASSETS.red!.href }, res.grid);
      let sum = 0;
      let n = 0;
      for (let i = 0; i < red.values.length; i++) {
        if (res.inside[i] && red.values[i]! > 0) {
          sum += red.values[i]!;
          n++;
        }
      }
      console.log(
        JSON.stringify({
          ms: Date.now() - started,
          grid: { width: res.grid.width, height: res.grid.height, epsg: res.grid.epsg, transform: res.grid.transform },
          insideCount: res.insideCount,
          meanRedDN: n ? sum / n : null,
          ndvi: { status: ndvi.status, metrics: ndvi.metrics && { ...ndvi.metrics, histogram: ndvi.metrics.histogram.counts }, quality: ndvi.quality },
          ndwi: { status: res.ndwi!.status, metrics: res.ndwi!.metrics },
          maskReasons: res.maskReasons,
          pngBytes: ndvi.png.length,
        }),
      );
      expect(res.grid.epsg).toBe(32618);
      expect((res.grid.transform[0] - 199_980) % 10).toBe(0);
      expect(res.insideCount).toBeGreaterThan(2000);
      expect(ndvi.quality.coverage_fraction).toBe(1);
      expect(ndvi.quality.gsd_m).toBe(10);
      if (ndvi.status === "valid") {
        const m = ndvi.metrics!;
        expect(m.min).toBeGreaterThanOrEqual(-1);
        expect(m.max).toBeLessThanOrEqual(1);
        expect(m.mean).toBeGreaterThan(-0.2);
        expect(m.mean).toBeLessThan(0.95);
        expect(m.p10).toBeLessThanOrEqual(m.median);
        expect(m.median).toBeLessThanOrEqual(m.p90);
      } else {
        expect(ndvi.quality.unusable_reason).toBeTruthy();
      }
      expect(ndvi.quality.flags).toContain("reflectance_offset_overridden");
    },
    180_000,
  );
});
