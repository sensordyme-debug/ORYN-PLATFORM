import { describe, expect, it } from "vitest";
import { InvalidInputError } from "@/server/analytics/errors";
import { bandScaling, belowThreshold, linearToDb, ndvi, ndwi, toReflectance } from "@/server/analytics/indices";
import { histogram, meanOf, percentileOfSorted, summarize } from "@/server/analytics/stats";

const S2_NEW = { scale: 0.0001, offset: -0.1, nodata: 0 }; // processing baseline ≥ 04.00
const S2_OLD = { scale: 0.0001, offset: 0, nodata: 0 };

describe("band scaling", () => {
  it("takes scale/offset/nodata from raster:bands, falling back to the file nodata", () => {
    expect(bandScaling({ scale: 0.0001, offset: -0.1, nodata: 0 }, null)).toEqual(S2_NEW);
    expect(bandScaling({ scale: 2.75e-5, offset: -0.2 }, 0)).toEqual({ scale: 2.75e-5, offset: -0.2, nodata: 0 });
    expect(bandScaling({ scale: 0.0001 }, null)).toEqual({ scale: 0.0001, offset: 0, nodata: null });
  });

  it("refuses to guess when a reflectance band publishes no scale", () => {
    expect(() => bandScaling({ nodata: 0 }, 0, { requireScale: true, label: "Band red" })).toThrow(InvalidInputError);
    expect(() => bandScaling(undefined, 0, { requireScale: true })).toThrow(/scale\/offset/);
  });

  it("converts DN to reflectance, skipping nodata", () => {
    const r = toReflectance(Uint16Array.from([0, 1000, 3000]), S2_NEW);
    expect(Number.isNaN(r[0]!)).toBe(true);
    expect(r[1]).toBeCloseTo(0, 6);
    expect(r[2]).toBeCloseTo(0.2, 6);
  });
});

describe("NDVI / NDWI", () => {
  it("applies the baseline −0.1 offset before the ratio", () => {
    // NIR DN 4000 → 0.30, Red DN 1500 → 0.05 → NDVI = 0.25/0.35
    const v = ndvi(Uint16Array.from([4000]), S2_NEW, Uint16Array.from([1500]), S2_NEW, null);
    expect(v[0]).toBeCloseTo(0.25 / 0.35, 6);
    // Ignoring the offset would give (4000−1500)/(5500) = 0.4545… — a different number.
    const old = ndvi(Uint16Array.from([4000]), S2_OLD, Uint16Array.from([1500]), S2_OLD, null);
    expect(old[0]).toBeCloseTo(2500 / 5500, 6);
  });

  it("uses Landsat C2 L2 scaling", () => {
    const L = { scale: 2.75e-5, offset: -0.2, nodata: 0 };
    const nir = (0.4 + 0.2) / 2.75e-5;
    const red = (0.05 + 0.2) / 2.75e-5;
    const v = ndvi(Float64Array.from([nir]), L, Float64Array.from([red]), L, null);
    expect(v[0]).toBeCloseTo(0.35 / 0.45, 6);
  });

  it("returns NaN for nodata, masked pixels, non-positive denominators and out-of-range ratios", () => {
    const nir = Uint16Array.from([0, 4000, 4000, 900, 1100, 4000]);
    const red = Uint16Array.from([1500, 0, 1500, 900, 950, 1500]);
    const valid = Uint8Array.from([1, 1, 0, 1, 1, 1]);
    const v = ndvi(nir, S2_NEW, red, S2_NEW, valid);
    expect(Number.isNaN(v[0]!)).toBe(true); // nir nodata
    expect(Number.isNaN(v[1]!)).toBe(true); // red nodata
    expect(Number.isNaN(v[2]!)).toBe(true); // masked
    expect(Number.isNaN(v[3]!)).toBe(true); // both −0.01 → sum < 0
    expect(Number.isNaN(v[4]!)).toBe(true); // 0.01 and −0.005: ratio 3 is outside [−1, 1]
    expect(v[5]).toBeCloseTo(0.25 / 0.35, 6);
  });

  it("computes McFeeters NDWI = (Green − NIR)/(Green + NIR)", () => {
    const v = ndwi(Uint16Array.from([1600]), S2_NEW, Uint16Array.from([1200]), S2_NEW, null);
    expect(v[0]).toBeCloseTo((0.06 - 0.02) / (0.06 + 0.02), 6);
  });
});

describe("Sentinel-1 dB", () => {
  it("converts linear γ⁰ to dB and thresholds water candidates", () => {
    const db = linearToDb(Float32Array.from([1, 0.1, 0.01, 0, -32768, 0.0158]), -32768);
    expect(db[0]).toBeCloseTo(0, 6);
    expect(db[1]).toBeCloseTo(-10, 5);
    expect(db[2]).toBeCloseTo(-20, 5);
    expect(Number.isNaN(db[3]!)).toBe(true);
    expect(Number.isNaN(db[4]!)).toBe(true);
    expect(db[5]).toBeCloseTo(10 * Math.log10(0.0158), 5); // ≈ −18.01
    expect(Array.from(belowThreshold(db, -18))).toEqual([0, 0, 1, 0, 0, 1]);
  });
});

describe("stats", () => {
  it("matches hand-computed values (population std, type-7 percentiles)", () => {
    const v = Float32Array.from([0.1, 0.2, 0.3, 0.4, Number.NaN, 0.5]);
    const s = summarize(v)!;
    expect(s.count).toBe(5);
    expect(s.mean).toBeCloseTo(0.3, 6);
    expect(s.median).toBeCloseTo(0.3, 6);
    expect(s.std).toBeCloseTo(Math.sqrt(0.02), 6); // deviations² sum 0.1 / 5
    expect(s.p10).toBeCloseTo(0.14, 6); // h = 0.4 → 0.1 + 0.4·0.1
    expect(s.p90).toBeCloseTo(0.46, 6); // h = 3.6 → 0.4 + 0.6·0.1
    expect(s.min).toBeCloseTo(0.1, 6);
    expect(s.max).toBeCloseTo(0.5, 6);
  });

  it("averages the middle pair for an even count and honours the include mask", () => {
    const v = Float32Array.from([4, 1, 3, 2, 100]);
    const s = summarize(v, Uint8Array.from([1, 1, 1, 1, 0]))!;
    expect(s.median).toBe(2.5);
    expect(s.max).toBe(4);
    expect(percentileOfSorted([1, 2, 3, 4], 0)).toBe(1);
    expect(percentileOfSorted([1, 2, 3, 4], 1)).toBe(4);
    expect(summarize(Float32Array.from([Number.NaN]))).toBeNull();
    expect(meanOf(Float32Array.from([1, 2, Number.NaN]))).toBe(1.5);
  });

  it("bins a fixed [−1, 1] range into 20 bins, closing the last bin", () => {
    const h = histogram(Float32Array.from([-1, -0.85, 0, 0.05, 0.999, 1, Number.NaN]), null, -1, 1, 20);
    expect(h.counts).toHaveLength(20);
    expect(h.counts[0]).toBe(1);
    expect(h.counts[1]).toBe(1);
    expect(h.counts[10]).toBe(2);
    expect(h.counts[19]).toBe(2);
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(6);
  });
});
