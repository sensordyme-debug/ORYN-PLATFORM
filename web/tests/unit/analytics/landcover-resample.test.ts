import { describe, expect, it } from "vitest";
import { CrsMismatchError, InvalidRasterError } from "@/server/analytics/errors";
import { IO_LULC_V02_TABLE, WORLDCOVER_TABLE, composition } from "@/server/analytics/landcover";
import { ellipsoidCellAreaM2, type Grid } from "@/server/analytics/raster/grid";
import { readSourceToGrid } from "@/server/analytics/raster/resample";
import { fill, memoryRaster } from "../../fixtures/analytics/fake-raster";

describe("landcover composition", () => {
  it("uses the published class codes and labels", () => {
    expect(WORLDCOVER_TABLE.classes.map((c) => c.code)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100]);
    expect(WORLDCOVER_TABLE.classes.find((c) => c.code === 60)!.label).toBe("Bare / sparse vegetation");
    expect(IO_LULC_V02_TABLE.classes.map((c) => c.code)).toEqual([1, 2, 4, 5, 7, 8, 9, 10, 11]);
    expect(IO_LULC_V02_TABLE.classes.find((c) => c.code === 11)!.label).toBe("Rangeland");
  });

  it("sums per-row ellipsoidal areas on an EPSG:4326 grid", () => {
    // WorldCover-like grid: 1/12000° pixels, 3 rows × 2 columns near 60° N.
    const d = 1 / 12000;
    const top = 60;
    const grid: Grid = { width: 2, height: 3, epsg: 4326, transform: [10, d, 0, top, 0, -d] };
    const codes = Uint8Array.from([10, 10, 80, 0, 40, 77]);
    const inside = Uint8Array.from([1, 1, 1, 1, 1, 1]);
    const res = composition(codes, inside, grid, WORLDCOVER_TABLE);
    const rowArea = (r: number) => ellipsoidCellAreaM2(top - (r + 1) * d, top - r * d, d);
    expect(rowArea(0)).toBeLessThan(rowArea(2)); // rows get larger towards the equator
    const tree = res.metrics.classes.find((c) => c.code === 10)!;
    expect(tree.pixels).toBe(2);
    expect(tree.area_m2).toBeCloseTo(2 * rowArea(0), 6);
    const water = res.metrics.classes.find((c) => c.code === 80)!;
    expect(water.area_m2).toBeCloseTo(rowArea(1), 6);
    const crop = res.metrics.classes.find((c) => c.code === 40)!;
    expect(crop.area_m2).toBeCloseTo(rowArea(2), 6);
    const validArea = 2 * rowArea(0) + rowArea(1) + rowArea(2);
    expect(tree.fraction).toBeCloseTo((2 * rowArea(0)) / validArea, 9);
    expect(res.metrics.classes.reduce((a, c) => a + c.fraction, 0)).toBeCloseTo(1, 12);
    expect(res.validPixels).toBe(4);
    expect(res.noDataPixels).toBe(1);
    expect(res.unknownCodes).toEqual([77]);
    expect(res.metrics.valid_fraction).toBeCloseTo(4 / 6, 12);
    expect(res.metrics.total_pixels).toBe(6);
    // ~4.6 m × 9.3 m at 60° N
    expect(res.metrics.pixel_area_m2).toBeGreaterThan(40);
    expect(res.metrics.pixel_area_m2).toBeLessThan(45);
  });

  it("excludes IO 'Clouds' from land cover", () => {
    const grid: Grid = { width: 4, height: 1, epsg: 32618, transform: [0, 10, 0, 0, 0, -10] };
    const res = composition(Uint8Array.from([1, 10, 2, 2]), new Uint8Array(4).fill(1), grid, IO_LULC_V02_TABLE);
    expect(res.nonLandCoverPixels).toBe(1);
    expect(res.metrics.classes.map((c) => [c.label, c.pixels, c.area_m2])).toEqual([
      ["Trees", 2, 200],
      ["Water", 1, 100],
    ]);
    expect(res.metrics.classes[0]!.fraction).toBeCloseTo(2 / 3, 12);
  });
});

describe("readSourceToGrid", () => {
  const S2 = { epsg: 32618, originX: 199_980, originY: 4_000_020 };

  it("is the identity on a shared lattice and reads a single window", async () => {
    const band = fill(new Uint16Array(100), 10, (c, r) => r * 10 + c);
    const src = memoryRaster({ ...S2, pixelW: 10, width: 10, height: 10, samples: [band], nodata: 0 });
    const grid: Grid = { width: 3, height: 2, epsg: 32618, transform: [199_980 + 20, 10, 0, 4_000_020 - 50, 0, -10] };
    const read = await readSourceToGrid(src, grid);
    expect(Array.from(read.values)).toEqual([52, 53, 54, 62, 63, 64]);
    expect(read.values).toBeInstanceOf(Uint16Array);
    expect(src.windowsRead).toEqual([[2, 5, 5, 7]]);
    expect(Array.from(read.footprint)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(read.downsampled).toBe(false);
  });

  it("maps a coarser 20 m band onto a 10 m grid by pixel centre", async () => {
    const scl = fill(new Uint8Array(25), 5, (c, r) => r * 5 + c);
    const src = memoryRaster({ ...S2, pixelW: 20, width: 5, height: 5, samples: [scl] });
    const grid: Grid = { width: 4, height: 2, epsg: 32618, transform: [199_980 + 10, 10, 0, 4_000_020, 0, -10] };
    const read = await readSourceToGrid(src, grid);
    // Columns at x-offsets 10–20, 20–30, 30–40, 40–50 → centres 15, 25, 35, 45 → 20 m columns 0, 1, 1, 2.
    expect(Array.from(read.values)).toEqual([0, 1, 1, 2, 0, 1, 1, 2]);
  });

  it("flags target pixels outside the image and fills them with nodata", async () => {
    const src = memoryRaster({ ...S2, pixelW: 10, width: 2, height: 2, samples: [Uint16Array.from([5, 6, 7, 8])], nodata: 0 });
    const grid: Grid = { width: 3, height: 1, epsg: 32618, transform: [199_980 - 10, 10, 0, 4_000_020, 0, -10] };
    const read = await readSourceToGrid(src, grid);
    expect(Array.from(read.values)).toEqual([0, 5, 6]);
    expect(Array.from(read.footprint)).toEqual([0, 1, 1]);
    const away: Grid = { ...grid, transform: [0, 10, 0, 0, 0, -10] };
    const none = await readSourceToGrid(src, away);
    expect(Array.from(none.footprint)).toEqual([0, 0, 0]);
    expect(src.windowsRead).toHaveLength(1);
  });

  it("refuses a CRS mismatch and invalid samples", async () => {
    const src = memoryRaster({ ...S2, pixelW: 10, width: 2, height: 2, samples: [new Uint16Array(4)] });
    await expect(readSourceToGrid(src, { width: 1, height: 1, epsg: 32617, transform: [199_980, 10, 0, 4_000_020, 0, -10] })).rejects.toThrow(CrsMismatchError);
    await expect(
      readSourceToGrid(src, { width: 1, height: 1, epsg: 32618, transform: [199_980, 10, 0, 4_000_020, 0, -10] }, { samples: [1] }),
    ).rejects.toThrow(InvalidRasterError);
  });

  it("uses overviews only when allowed, picking the coarsest not coarser than the target", async () => {
    const full = new Uint16Array(64).fill(1);
    const src = memoryRaster({
      ...S2,
      pixelW: 10,
      width: 8,
      height: 8,
      samples: [full],
      overviews: [
        { width: 4, height: 4, pixelW: 20, pixelH: 20, samples: [new Uint16Array(16).fill(2)] },
        { width: 2, height: 2, pixelW: 40, pixelH: 40, samples: [new Uint16Array(4).fill(4)] },
      ],
    });
    const grid: Grid = { width: 2, height: 2, epsg: 32618, transform: [199_980, 30, 0, 4_000_020, 0, -30] };
    expect((await readSourceToGrid(src, grid)).values[0]).toBe(1);
    const preview = await readSourceToGrid(src, grid, { allowOverviews: true });
    expect(preview.values[0]).toBe(2);
    expect(preview.downsampled).toBe(true);
  });
});
