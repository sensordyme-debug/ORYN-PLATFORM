import { describe, expect, it } from "vitest";
import type { Ring } from "@/lib/geo";
import type { Grid } from "@/server/analytics/raster/grid";
import { landsatQaValidMask, s1ValidMask, sclValidMask } from "@/server/analytics/raster/masks";
import { countInside, rasterizeMultiPolygon } from "@/server/analytics/raster/rasterize";

/** 10 × 10 grid of 1-unit pixels covering x ∈ [0, 10], y ∈ [0, 10]. */
const G: Grid = { width: 10, height: 10, epsg: 32618, transform: [0, 1, 0, 10, 0, -1] };

const rect = (x0: number, y0: number, x1: number, y1: number): Ring => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];

function rows(mask: Uint8Array, g: Grid): string[] {
  const out: string[] = [];
  for (let r = 0; r < g.height; r++) out.push(Array.from(mask.subarray(r * g.width, (r + 1) * g.width)).join(""));
  return out;
}

describe("rasterizeMultiPolygon", () => {
  it("fills a square by the pixel-centre rule", () => {
    // Square from 2 to 5 covers centres 2.5, 3.5, 4.5 in both axes.
    const m = rasterizeMultiPolygon([[rect(2, 2, 5, 5)]], G);
    expect(countInside(m)).toBe(9);
    expect(rows(m, G)[5]).toBe("0011100000"); // row 5 has centre y = 4.5
    expect(rows(m, G)[4]).toBe("0000000000"); // centre y = 5.5 is outside
  });

  it("includes a pixel only when its centre is inside, not when merely touched", () => {
    // 2.4 … 2.6 contains the centre 2.5 of column 2; 3.6 … 4.4 touches columns 3 and 4 but contains no centre.
    expect(countInside(rasterizeMultiPolygon([[rect(2.4, 2.4, 2.6, 2.6)]], G))).toBe(1);
    expect(countInside(rasterizeMultiPolygon([[rect(3.6, 3.6, 4.4, 4.4)]], G))).toBe(0);
  });

  it("excludes holes (even-odd)", () => {
    const m = rasterizeMultiPolygon([[rect(1, 1, 9, 9), rect(3, 3, 7, 7)]], G);
    expect(countInside(m)).toBe(64 - 16);
    expect(rows(m, G)[5]).toBe("0110000110");
  });

  it("ORs the polygons of a MultiPolygon", () => {
    const m = rasterizeMultiPolygon([[rect(0, 0, 2, 2)], [rect(8, 8, 10, 10)]], G);
    expect(countInside(m)).toBe(8);
    expect(rows(m, G)[0]).toBe("0000000011");
    expect(rows(m, G)[9]).toBe("1100000000");
  });

  it("handles a triangle and clips to the grid", () => {
    const tri: Ring = [
      [0, 0],
      [10, 0],
      [0, 10],
      [0, 0],
    ];
    const m = rasterizeMultiPolygon([[tri]], G);
    // Centres (c+.5, y) with x + y < 10: row with y = 0.5 has 9 columns (c+.5 < 9.5 → c ≤ 8 … strictly < 9.5).
    expect(countInside(m)).toBe(45);
    const big = rasterizeMultiPolygon([[rect(-50, -50, 50, 50)]], G);
    expect(countInside(big)).toBe(100);
  });

  it("never lets two polygons sharing an edge both claim a pixel", () => {
    const a = rasterizeMultiPolygon([[rect(0, 0, 4.5, 10)]], G);
    const b = rasterizeMultiPolygon([[rect(4.5, 0, 10, 10)]], G);
    for (let i = 0; i < a.length; i++) expect(a[i]! + b[i]!).toBe(1);
  });
});

describe("masks", () => {
  it("SCL keeps vegetation, not-vegetated and water by default", () => {
    const scl = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const m = sclValidMask(scl);
    expect(Array.from(m.valid)).toEqual([0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0]);
    expect(m.validCount).toBe(3);
    expect(m.maskedCount).toBe(9);
    expect(m.reasons).toMatchObject({ no_data: 1, cloud_shadow: 1, cloud_high_probability: 1, thin_cirrus: 1, snow_ice: 1, unclassified: 1 });
    const withUnclassified = sclValidMask(scl, { includeUnclassified: true });
    expect(withUnclassified.valid[7]).toBe(1);
    expect(withUnclassified.validCount).toBe(4);
  });

  it("SCL counts only inside the AOI and treats out-of-footprint as no data", () => {
    const scl = Uint8Array.from([4, 9, 4, 4]);
    const inside = Uint8Array.from([1, 1, 1, 0]);
    const footprint = Uint8Array.from([1, 1, 0, 1]);
    const m = sclValidMask(scl, { inside, footprint });
    expect(Array.from(m.valid)).toEqual([1, 0, 0, 0]);
    expect(m.maskedCount).toBe(2);
    expect(m.reasons).toEqual({ cloud_high_probability: 1, no_data: 1 });
  });

  it("Landsat QA_PIXEL excludes fill, dilated cloud, cirrus, cloud, shadow and snow", () => {
    const bit = (...b: number[]) => b.reduce((v, i) => v | (1 << i), 0);
    const qa = Uint16Array.from([
      bit(6), // clear
      bit(6, 7), // clear water
      bit(0), // fill
      bit(1), // dilated cloud
      bit(2), // cirrus
      bit(3, 1), // cloud (+dilated): reported as cloud
      bit(4), // shadow
      bit(5), // snow
      21824, // typical L8 "clear, low confidence" value: bits 6, 8, 10, 12, 14
    ]);
    const m = landsatQaValidMask(qa);
    expect(Array.from(m.valid)).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 1]);
    expect(m.reasons).toEqual({ fill: 1, dilated_cloud: 1, cirrus: 1, cloud: 1, cloud_shadow: 1, snow: 1 });
    expect(m.maskedCount).toBe(6);
  });

  it("S1 mask drops nodata, non-finite and non-positive backscatter", () => {
    const vv = Float32Array.from([0.05, -32768, 0, -0.01, Number.NaN, 0.001]);
    const m = s1ValidMask(vv, -32768);
    expect(Array.from(m.valid)).toEqual([1, 0, 0, 0, 0, 1]);
    expect(m.reasons).toEqual({ no_data: 2, non_positive_backscatter: 2 });
  });
});
