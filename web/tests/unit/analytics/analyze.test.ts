import { describe, expect, it } from "vitest";
import type { MultiPolygonGeometry, Position } from "@/lib/geo";
import type { AssetFile } from "@/server/providers/types";
import { analyzeLandcover, analyzeOptical, analyzeS1Water } from "@/server/analytics/analyze";
import { InvalidInputError } from "@/server/analytics/errors";
import { ellipsoidCellAreaM2, pixelCenter } from "@/server/analytics/raster/grid";
import { transformPoint } from "@/server/analytics/raster/projection";
import type { RasterSource, TypedArray } from "@/server/analytics/raster/resample";
import { memResolve, memoryOpener, memoryRaster } from "../../fixtures/analytics/fake-raster";

const EPSG = 32618;
const ORIGIN = { originX: 199_980, originY: 4_000_020 };
const AOI_BOX = { x0: 200_500, y0: 3_999_000, x1: 200_800, y1: 3_999_300 }; // 300 m × 300 m → 900 pixels at 10 m

/** AOI given in lon/lat (as the platform stores it), built from a UTM box. */
function aoiFromUtm(box: { x0: number; y0: number; x1: number; y1: number }, epsg = EPSG): MultiPolygonGeometry {
  const corners: Position[] = [
    [box.x0, box.y0],
    [box.x1, box.y0],
    [box.x1, box.y1],
    [box.x0, box.y1],
    [box.x0, box.y0],
  ].map((p) => transformPoint(epsg, 4326, p as Position));
  return { type: "MultiPolygon", coordinates: [[corners]] };
}

type Field = (x: number, y: number) => number;

/** A band on a pixel lattice anchored at ORIGIN, values from f(pixel-centre x, y). */
function band(pixel: number, width: number, height: number, f: Field, ctor: new (n: number) => TypedArray = Uint16Array, nodata: number | null = 0, origin = ORIGIN) {
  const data = new ctor(width * height);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) data[r * width + c] = f(origin.originX + (c + 0.5) * pixel, origin.originY - (r + 0.5) * pixel);
  }
  return memoryRaster({ epsg: EPSG, ...origin, pixelW: pixel, width, height, samples: [data], nodata });
}

const S2_REFL = { scale: 0.0001, offset: -0.1, nodata: 0 };
const s2Assets = (keys: string[]): Record<string, AssetFile> =>
  Object.fromEntries(keys.map((k) => [k, { href: `mem://${k}`, bands: k === "scl" ? [{ nodata: 0 }] : k === "visual" ? [{ nodata: 0 }, { nodata: 0 }, { nodata: 0 }] : [S2_REFL] }]));

/** Sentinel-2-like scene: 10 m reflectance bands 150 × 150, 20 m SCL 75 × 75. */
function s2Scene(opts: { red?: Field; nir?: Field; green?: Field; scl?: Field; widthPx?: number }) {
  const w = opts.widthPx ?? 150;
  const rasters: Record<string, RasterSource> = {
    red: band(10, w, 150, opts.red ?? (() => 1500)), // 0.05
    nir: band(10, w, 150, opts.nir ?? (() => 4000)), // 0.30
    green: band(10, w, 150, opts.green ?? (() => 1600)), // 0.06
    scl: band(20, Math.ceil(w / 2), 75, opts.scl ?? (() => 4), Uint8Array),
  };
  return { rasters, open: memoryOpener(rasters) };
}

const NDVI_VEG = 0.25 / 0.35;

describe("analyzeOptical (Sentinel-2)", () => {
  it("computes NDMI from B8A/B11 on their native 20 m grid, masks cloud, and refuses to share the 10 m NDVI grid", async () => {
    // NIR08 0.30, SWIR16 0.15 → NDMI = 0.15 / 0.45 = 1/3; SCL cloud (9) in the south half of the AOI.
    const rasters: Record<string, RasterSource> = {
      nir08: band(20, 75, 75, () => 4000),
      swir16: band(20, 75, 75, () => 2500),
      scl: band(20, 75, 75, (_x, y) => (y < 3_999_150 ? 9 : 4), Uint8Array),
    };
    const assets = s2Assets(["nir08", "swir16", "scl"]);
    const base = { collection: "sentinel-2-l2a" as const, assets, aoi: aoiFromUtm(AOI_BOX), resolve: memResolve, sceneCloudCover: 10, deps: { open: memoryOpener(rasters) } };
    const res = await analyzeOptical({ ...base, want: { ndvi: false, ndwi: false, trueColor: false, ndmi: true } });
    expect(res.grid.transform[1]).toBe(20);
    expect(res.insideCount).toBe(225); // 300 m × 300 m at 20 m
    const ndmi = res.ndmi!;
    expect(ndmi.status).toBe("valid");
    expect(ndmi.metrics!.mean).toBeCloseTo(1 / 3, 6);
    expect(ndmi.metrics!.valid_fraction).toBeCloseTo(0.5, 1);
    expect(ndmi.quality.gsd_m).toBe(20);
    expect(ndmi.legend.kind).toBe("ndmi");
    expect(res.ndvi).toBeUndefined();
    await expect(analyzeOptical({ ...base, assets: s2Assets(["red", "nir", "nir08", "swir16", "scl"]), want: { ndvi: true, ndwi: false, trueColor: false, ndmi: true } })).rejects.toMatchObject({
      reason: "separate_grid_required",
    });
  });

  it("computes NDVI and NDWI on the native 10 m lattice for a clear scene", async () => {
    // West of x = 200 650 is water: NIR 0.01, Green 0.06 → NDWI 0.714, NDVI −0.667.
    const water = (x: number) => x < 200_650;
    const { open } = s2Scene({ nir: (x) => (water(x) ? 1100 : 4000) });
    const res = await analyzeOptical({
      collection: "sentinel-2-l2a",
      assets: s2Assets(["red", "nir", "green", "scl"]),
      aoi: aoiFromUtm(AOI_BOX),
      resolve: memResolve,
      sceneCloudCover: 3.2,
      want: { ndvi: true, ndwi: true, trueColor: false },
      deps: { open },
    });
    expect(res.insideCount).toBe(900);
    expect(res.grid.epsg).toBe(EPSG);
    expect((res.grid.transform[0] - ORIGIN.originX) % 10).toBe(0);
    expect((ORIGIN.originY - res.grid.transform[3]) % 10).toBe(0);
    expect(res.coverageFraction).toBe(1);

    const ndvi = res.ndvi!;
    expect(ndvi.status).toBe("valid");
    expect(ndvi.quality).toMatchObject({ coverage_fraction: 1, masked_fraction: 0, scene_cloud_cover: 3.2, gsd_m: 10, flags: [] });
    const m = ndvi.metrics!;
    expect(m.total_pixels).toBe(900);
    expect(m.valid_pixels).toBe(900);
    expect(m.valid_fraction).toBe(1);
    expect(m.pixel_area_m2).toBe(100);
    expect(m.max).toBeCloseTo(NDVI_VEG, 5);
    expect(m.min).toBeCloseTo(-0.04 / 0.06, 5);
    expect(m.histogram.counts.reduce((a, b) => a + b, 0)).toBe(900);
    expect(ndvi.png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(ndvi.legend.kind).toBe("ndvi");

    // Expected water share from the actual AOI pixels.
    let wet = 0;
    for (let i = 0; i < res.inside.length; i++) {
      if (!res.inside[i]) continue;
      if (water(pixelCenter(res.grid, i % res.grid.width, Math.floor(i / res.grid.width))[0])) wet++;
    }
    expect(wet).toBe(450);
    const w = res.ndwi!.metrics!;
    expect(res.ndwi!.status).toBe("valid");
    expect(w.water_fraction).toBeCloseTo(wet / 900, 12);
    expect(w.water_area_m2).toBe(wet * 100);
    expect(w.threshold).toBe(0);
    expect(w.mean_index).toBeCloseTo((0.05 / 0.07 + -0.24 / 0.36) / 2, 5);
    expect(m.mean).toBeCloseTo((NDVI_VEG + -0.04 / 0.06) / 2, 5);
  });

  it("marks a mostly cloudy scene unusable without fabricating metrics", async () => {
    // SCL 9 (high-probability cloud) everywhere west of x = 200 760 → ~13 % clear.
    const { open } = s2Scene({ scl: (x) => (x < 200_760 ? 9 : 4) });
    const res = await analyzeOptical({
      collection: "sentinel-2-l2a",
      assets: s2Assets(["red", "nir", "scl"]),
      aoi: aoiFromUtm(AOI_BOX),
      resolve: memResolve,
      sceneCloudCover: 71,
      want: { ndvi: true, ndwi: false, trueColor: false },
      deps: { open },
    });
    const ndvi = res.ndvi!;
    expect(ndvi.status).toBe("unusable");
    expect(ndvi.metrics).toBeNull();
    expect(ndvi.quality.flags).toEqual(expect.arrayContaining(["high_mask_fraction", "below_min_valid_fraction"]));
    expect(ndvi.quality.flags).not.toContain("partial_coverage");
    expect(ndvi.quality.coverage_fraction).toBe(1);
    expect(ndvi.quality.masked_fraction).toBeCloseTo(26 / 30, 10); // 20 m SCL: clear from x = 200 760
    expect(ndvi.quality.unusable_reason).toBe("Only 13% of the area was cloud-free in this image (minimum 20%).");
    expect(res.maskReasons.cloud_high_probability).toBe(780);
    // The clear pixels keep their real values; masked pixels are NaN.
    const finite = Array.from(ndvi.values).filter(Number.isFinite);
    expect(finite).toHaveLength(120);
    expect(finite.every((v) => Math.abs(v - NDVI_VEG) < 1e-6)).toBe(true);
    expect(ndvi.png.length).toBeGreaterThan(0);
  });

  it("reports partial coverage when the scene ends inside the AOI", async () => {
    // Bands end at x = 199 980 + 700 = 200 680 → 18 of 30 AOI columns covered.
    const { open } = s2Scene({ widthPx: 70 });
    const res = await analyzeOptical({
      collection: "sentinel-2-l2a",
      assets: s2Assets(["red", "nir", "scl"]),
      aoi: aoiFromUtm(AOI_BOX),
      resolve: memResolve,
      sceneCloudCover: null,
      want: { ndvi: true, ndwi: false, trueColor: false },
      deps: { open },
    });
    const q = res.ndvi!.quality;
    expect(res.ndvi!.status).toBe("valid");
    expect(q.coverage_fraction).toBeCloseTo(0.6, 10);
    expect(q.masked_fraction).toBeCloseTo(0.4, 10);
    expect(q.flags).toEqual(["partial_coverage"]);
    expect(res.ndvi!.metrics!.valid_fraction).toBeCloseTo(0.6, 10);
    expect(res.ndvi!.metrics!.mean).toBeCloseTo(NDVI_VEG, 5);
  });

  it("reports an AOI outside the scene as unusable", async () => {
    const { open } = s2Scene({ widthPx: 40 }); // ends at x = 200 380
    const res = await analyzeOptical({
      collection: "sentinel-2-l2a",
      assets: s2Assets(["red", "nir", "scl"]),
      aoi: aoiFromUtm(AOI_BOX),
      resolve: memResolve,
      sceneCloudCover: null,
      want: { ndvi: true, ndwi: false, trueColor: false },
      deps: { open },
    });
    expect(res.ndvi!.status).toBe("unusable");
    expect(res.ndvi!.metrics).toBeNull();
    expect(res.ndvi!.quality.coverage_fraction).toBe(0);
    expect(res.ndvi!.quality.unusable_reason).toBe("This image does not cover the area of interest.");
  });

  it("renders true colour from the 8-bit visual asset", async () => {
    const { rasters } = s2Scene({});
    const rgb = [200, 120, 60].map((v) => new Uint8Array(150 * 150).fill(v));
    rasters.visual = memoryRaster({ epsg: EPSG, ...ORIGIN, pixelW: 10, width: 150, height: 150, samples: rgb, nodata: 0 });
    const open = memoryOpener(rasters);
    const res = await analyzeOptical({
      collection: "sentinel-2-l2a",
      assets: s2Assets(["red", "nir", "scl", "visual"]),
      aoi: aoiFromUtm(AOI_BOX),
      resolve: memResolve,
      sceneCloudCover: null,
      want: { ndvi: false, ndwi: false, trueColor: true },
      deps: { open },
    });
    expect(open.opened).toEqual(["mem://visual"]); // no reflectance or SCL reads needed
    expect(res.coverageFraction).toBe(1);
    expect(res.trueColor!.legend.kind).toBe("true_color");
    expect(res.ndvi).toBeUndefined();
  });

  it("refuses to run without published scale/offset, and honours aborts", async () => {
    const { open } = s2Scene({});
    const assets = s2Assets(["red", "nir", "scl"]);
    assets.red = { href: "mem://red", bands: [{ nodata: 0 }] };
    const base = {
      collection: "sentinel-2-l2a" as const,
      aoi: aoiFromUtm(AOI_BOX),
      resolve: memResolve,
      sceneCloudCover: null,
      want: { ndvi: true, ndwi: false, trueColor: false },
      deps: { open },
    };
    await expect(analyzeOptical({ ...base, assets })).rejects.toThrow(InvalidInputError);
    const ac = new AbortController();
    ac.abort();
    await expect(analyzeOptical({ ...base, assets: s2Assets(["red", "nir", "scl"]), signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
    await expect(analyzeOptical({ ...base, assets: s2Assets(["red", "nir"]) })).rejects.toThrow(/"scl" asset/);
  });

  it("does not apply a BOA offset twice, and refuses implausible scaling", async () => {
    // Harmonized DNs (offset already applied by the provider): red 0.05, NIR 0.30 at offset 0,
    // while the item still publishes offset −0.1 (as Earth Search does).
    const { open } = s2Scene({ red: () => 500, nir: () => 3000 });
    const base = {
      collection: "sentinel-2-l2a" as const,
      assets: s2Assets(["red", "nir", "scl"]),
      aoi: aoiFromUtm(AOI_BOX),
      resolve: memResolve,
      sceneCloudCover: null,
      want: { ndvi: true, ndwi: false, trueColor: false },
      deps: { open },
    };
    await expect(analyzeOptical(base)).rejects.toMatchObject({ reason: "implausible_reflectance" });
    const res = await analyzeOptical({ ...base, boaOffsetApplied: true });
    expect(res.ndvi!.status).toBe("valid");
    expect(res.ndvi!.metrics!.mean).toBeCloseTo(NDVI_VEG, 5);
    expect(res.ndvi!.quality.flags).toEqual(["reflectance_offset_overridden"]);
  });

  it("rejects an AOI smaller than one pixel", async () => {
    const { open } = s2Scene({});
    await expect(
      analyzeOptical({
        collection: "sentinel-2-l2a",
        assets: s2Assets(["red", "nir", "scl"]),
        aoi: aoiFromUtm({ x0: 200_501, y0: 3_999_001, x1: 200_504, y1: 3_999_004 }),
        resolve: memResolve,
        sceneCloudCover: null,
        want: { ndvi: true, ndwi: false, trueColor: false },
        deps: { open },
      }),
    ).rejects.toMatchObject({ reason: "aoi_too_small" });
  });
});

describe("analyzeOptical (Landsat C2 L2)", () => {
  const L_ORIGIN = { originX: 199_985, originY: 4_000_015 };
  const L_REFL = { scale: 2.75e-5, offset: -0.2, nodata: 0 };
  const dn = (refl: number) => Math.round((refl + 0.2) / 2.75e-5);

  it("uses QA_PIXEL masking, Landsat scaling and the 30 m lattice", async () => {
    const CLOUD = 1 << 3;
    const CLEAR = 1 << 6;
    const mk = (f: Field, ctor: new (n: number) => TypedArray = Uint16Array, nodata: number | null = 0) => band(30, 60, 60, f, ctor, nodata, L_ORIGIN);
    const rasters = {
      red: mk(() => dn(0.05)),
      nir08: mk(() => dn(0.3)),
      green: mk(() => dn(0.06)),
      blue: mk(() => dn(0.04)),
      qa_pixel: mk((x) => (x < 200_560 ? CLOUD : CLEAR), Uint16Array, 1),
    };
    const assets: Record<string, AssetFile> = {
      red: { href: "mem://red", bands: [L_REFL] },
      nir08: { href: "mem://nir08", bands: [L_REFL] },
      green: { href: "mem://green", bands: [L_REFL] },
      blue: { href: "mem://blue", bands: [L_REFL] },
      qa_pixel: { href: "mem://qa_pixel", bands: [{ nodata: 1 }] },
    };
    const res = await analyzeOptical({
      collection: "landsat-c2-l2",
      assets,
      aoi: aoiFromUtm({ x0: 200_495, y0: 3_998_995, x1: 200_795, y1: 3_999_295 }), // 10 × 10 Landsat pixels
      resolve: memResolve,
      sceneCloudCover: 20,
      want: { ndvi: true, ndwi: false, trueColor: true },
      deps: { open: memoryOpener(rasters) },
    });
    expect(res.insideCount).toBe(100);
    expect(res.ndvi!.quality.gsd_m).toBe(30);
    expect(res.ndvi!.metrics!.pixel_area_m2).toBe(900);
    expect(res.ndvi!.metrics!.valid_pixels).toBe(80); // the two western columns are cloud
    expect(res.ndvi!.metrics!.mean).toBeCloseTo(0.25 / 0.35, 3);
    expect(res.maskReasons).toEqual({ cloud: 20 });
    expect(res.trueColor!.legend.min).toBeDefined();

    await expect(
      analyzeOptical({
        collection: "landsat-c2-l2",
        assets,
        aoi: aoiFromUtm(AOI_BOX),
        resolve: memResolve,
        sceneCloudCover: 20,
        want: { ndvi: false, ndwi: true, trueColor: false },
        deps: { open: memoryOpener(rasters) },
      }),
    ).rejects.toThrow(/Sentinel-2 L2A only/);
  });
});

describe("analyzeS1Water", () => {
  it("thresholds VV dB and summarizes water", async () => {
    // West of x = 200 600: 0.005 (−23 dB, water); east: 0.1 (−10 dB). A strip of nodata in the north.
    const vv = band(
      10,
      150,
      150,
      (x, y) => (y > 3_999_280 ? -32768 : x < 200_600 ? 0.005 : 0.1),
      Float32Array,
      -32768,
    );
    const res = await analyzeS1Water({
      assets: { vv: { href: "mem://vv", bands: [{ nodata: -32768, dataType: "float32" }] } },
      aoi: aoiFromUtm(AOI_BOX),
      resolve: memResolve,
      deps: { open: memoryOpener({ vv }) },
    });
    expect(res.status).toBe("valid");
    const m = res.metrics!;
    expect(m.total_pixels).toBe(900);
    expect(m.valid_pixels).toBe(900 - 60); // two northern rows are nodata
    expect(m.water_fraction).toBeCloseTo((10 * 28) / 840, 12);
    expect(m.water_area_m2).toBe(280 * 100);
    expect(m.threshold).toBe(-18);
    expect(m.mean_vv_db).toBeCloseTo((280 * 10 * Math.log10(0.005) + 560 * -10) / 840, 4);
    expect(res.quality.coverage_fraction).toBeCloseTo(840 / 900, 12);
    expect(res.quality.flags).toEqual(["partial_coverage"]);
    expect(res.legend.kind).toBe("water_mask");
    expect(res.waterMask.reduce((a, b) => a + b, 0)).toBe(280);
  });
});

describe("analyzeLandcover", () => {
  it("composes WorldCover classes on its EPSG:4326 grid with per-row areas", async () => {
    const d = 1 / 12000;
    const width = 1200;
    const height = 1200;
    const codes = new Uint8Array(width * height);
    for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) codes[r * width + c] = c < 600 ? 10 : 40; // west of −77.95: trees
    const map = memoryRaster({ epsg: 4326, originX: -78, originY: 36, pixelW: d, width, height, samples: [codes], nodata: 0 });
    const ring: Position[] = [
      [-77.96, 35.95],
      [-77.94, 35.95],
      [-77.94, 35.96],
      [-77.96, 35.96],
      [-77.96, 35.95],
    ];
    const res = await analyzeLandcover({
      collection: "esa-worldcover",
      assets: { map: { href: "mem://map", bands: [{ nodata: 0 }] } },
      aoi: { type: "Polygon", coordinates: [ring] },
      resolve: memResolve,
      deps: { open: memoryOpener({ map }) },
    });
    expect(res.status).toBe("valid");
    expect(res.grid.epsg).toBe(4326);
    expect(res.insideCount).toBe(240 * 120);
    const m = res.metrics!;
    expect(m.classes.map((c) => c.label).sort()).toEqual(["Cropland", "Tree cover"]);
    const total = m.classes.reduce((a, c) => a + c.area_m2, 0);
    let expected = 0;
    for (let r = 0; r < 120; r++) expected += 240 * ellipsoidCellAreaM2(35.96 - (r + 1) * d, 35.96 - r * d, d);
    expect(total / expected).toBeCloseTo(1, 9);
    expect(m.classes.find((c) => c.code === 10)!.fraction).toBeCloseTo(0.5, 6);
    expect(m.valid_fraction).toBe(1);
    expect(res.quality.gsd_m).toBeGreaterThan(8);
    expect(res.quality.gsd_m).toBeLessThan(9);
    expect(res.legend.stops!.map((s) => s.value)).toEqual([10, 40, -9999]);
  });
});
