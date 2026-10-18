import { describe, expect, it } from "vitest";
import { computeIndex, EVI_COEFFICIENTS, ndvi, SAVI_L, SPECTRAL_INDICES, type BandScaling } from "@/server/analytics/indices";

/**
 * Reference values are worked by hand from the published formulas (Huete et
 * al. 2002 for EVI with G 2.5, C1 6, C2 7.5, L 1; Huete 1988 for SAVI with
 * L 0.5 — the coefficients of the USGS Landsat Level-2 EVI and SAVI
 * products), not from the code under test.
 */
const REFL: BandScaling = { scale: 1, offset: 0, nodata: null }; // values given directly as reflectance
const S2: BandScaling = { scale: 0.0001, offset: -0.1, nodata: 0 }; // Sentinel-2 L2A, processing baseline ≥ 04.00
const LANDSAT: BandScaling = { scale: 2.75e-5, offset: -0.2, nodata: 0 }; // Landsat Collection 2 Level-2
const f = (...v: number[]) => Float64Array.from(v);
const one = (values: Float64Array | Uint16Array, scaling = REFL) => ({ values, scaling });

describe("EVI", () => {
  it("uses the USGS / Huete et al. (2002) coefficients", () => {
    expect(EVI_COEFFICIENTS).toEqual({ G: 2.5, C1: 6, C2: 7.5, L: 1 });
    expect(SPECTRAL_INDICES.evi.bands).toEqual(["nir", "red", "blue"]);
  });

  it("matches a hand-worked value", () => {
    // NIR 0.40, Red 0.05, Blue 0.03: 2.5 × 0.35 / (0.40 + 0.30 − 0.225 + 1) = 0.875 / 1.475
    const { values, rejected } = computeIndex(SPECTRAL_INDICES.evi, [one(f(0.4)), one(f(0.05)), one(f(0.03))], null);
    expect(values[0]).toBeCloseTo(0.875 / 1.475, 6); // 0.593220…
    expect(rejected).toEqual({ invalid_denominator: 0, out_of_range: 0 });
  });

  it("applies each band's scale and offset first: Sentinel-2 digital numbers give the same EVI as the reflectances", () => {
    // DN 5000 / 1500 / 1300 → 0.40 / 0.05 / 0.03 after × 0.0001 − 0.1
    const scaled = computeIndex(SPECTRAL_INDICES.evi, [one(Uint16Array.from([5000]), S2), one(Uint16Array.from([1500]), S2), one(Uint16Array.from([1300]), S2)], null);
    expect(scaled.values[0]).toBeCloseTo(0.875 / 1.475, 6);
    // Ignoring the −0.1 offset gives 0.50 / 0.15 / 0.13 → 0.875 / 1.425: a different, wrong number.
    const noOffset = { ...S2, offset: 0 };
    const wrong = computeIndex(SPECTRAL_INDICES.evi, [one(Uint16Array.from([5000]), noOffset), one(Uint16Array.from([1500]), noOffset), one(Uint16Array.from([1300]), noOffset)], null);
    expect(wrong.values[0]).toBeCloseTo(0.875 / 1.425, 6);
    expect(Math.abs(wrong.values[0]! - scaled.values[0]!)).toBeGreaterThan(0.02);
  });

  it("uses Landsat Collection 2 scaling", () => {
    // reflectance = DN × 2.75e-5 − 0.2: DN 21 818.18 → 0.40, 9 090.91 → 0.05, 8 363.64 → 0.03
    const dn = (r: number) => Uint16Array.from([Math.round((r + 0.2) / 2.75e-5)]);
    const { values } = computeIndex(SPECTRAL_INDICES.evi, [one(dn(0.4), LANDSAT), one(dn(0.05), LANDSAT), one(dn(0.03), LANDSAT)], null);
    expect(values[0]).toBeCloseTo(0.875 / 1.475, 4);
  });

  it("rejects, and counts, a non-positive denominator and values outside −1 to 1", () => {
    // Bright blue (residual cloud): 0.05 + 0.12 − 2.25 + 1 = −1.08 ≤ 0.
    // NIR 0.6, Red 0.05, Blue 0.18: 2.5 × 0.55 / 0.55 = 2.5 > 1.
    const { values, rejected } = computeIndex(SPECTRAL_INDICES.evi, [one(f(0.05, 0.6, 0.4)), one(f(0.02, 0.05, 0.05)), one(f(0.3, 0.18, 0.03))], null);
    expect(Number.isNaN(values[0]!)).toBe(true);
    expect(Number.isNaN(values[1]!)).toBe(true);
    expect(values[2]).toBeCloseTo(0.875 / 1.475, 6);
    expect(rejected).toEqual({ invalid_denominator: 1, out_of_range: 1 });
  });
});

describe("SAVI", () => {
  it("uses L = 0.5", () => {
    expect(SAVI_L).toBe(0.5);
    expect(SPECTRAL_INDICES.savi.parameters).toEqual({ L: 0.5 });
  });

  it("matches hand-worked values for canopy and for bare soil", () => {
    // Canopy: 1.5 × 0.35 / 0.95 = 0.552631…; bare soil NIR 0.25 Red 0.20: 1.5 × 0.05 / 0.95 = 0.078947…
    const { values } = computeIndex(SPECTRAL_INDICES.savi, [one(f(0.4, 0.25)), one(f(0.05, 0.2))], null);
    expect(values[0]).toBeCloseTo(0.525 / 0.95, 6);
    expect(values[1]).toBeCloseTo(0.075 / 0.95, 6);
    // Over the same soil NDVI is 0.05 / 0.45 = 0.111: SAVI damps the soil-background signal.
    expect(values[1]!).toBeLessThan(0.05 / 0.45);
  });
});

describe("shared index engine", () => {
  it("gives NDVI exactly as the original normalized difference did", () => {
    const nir = Uint16Array.from([4000, 0, 3000, 1200, 9000]);
    const red = Uint16Array.from([1500, 1500, 0, 1300, 1100]);
    const before = ndvi(nir, S2, red, S2, null);
    const after = computeIndex(SPECTRAL_INDICES.ndvi, [one(nir, S2), one(red, S2)], null).values;
    expect([...after].map((v) => (Number.isNaN(v) ? "NaN" : v))).toEqual([...before].map((v) => (Number.isNaN(v) ? "NaN" : v)));
  });

  it("never fills masked or nodata pixels, and does not count them as rejections", () => {
    const valid = Uint8Array.from([0, 1, 1]);
    const { values, rejected } = computeIndex(
      SPECTRAL_INDICES.savi,
      [one(Uint16Array.from([5000, 0, 5000]), S2), one(Uint16Array.from([1500, 1500, 1500]), S2)],
      valid,
    );
    expect(Number.isNaN(values[0]!)).toBe(true); // masked (cloud)
    expect(Number.isNaN(values[1]!)).toBe(true); // NIR nodata
    expect(values[2]).toBeCloseTo(0.525 / 0.95, 5);
    expect(rejected).toEqual({ invalid_denominator: 0, out_of_range: 0 });
  });

  it("refuses the wrong number of bands or mismatched shapes", () => {
    expect(() => computeIndex(SPECTRAL_INDICES.evi, [one(f(0.4)), one(f(0.05))], null)).toThrow(/needs 3 bands/);
    expect(() => computeIndex(SPECTRAL_INDICES.ndvi, [one(f(0.4, 0.3)), one(f(0.05))], null)).toThrow(/same length/);
  });

  it("documents a formula, reference and valid range for every index", () => {
    for (const def of Object.values(SPECTRAL_INDICES)) {
      expect(def.formula.length).toBeGreaterThan(10);
      expect(def.reference.length).toBeGreaterThan(10);
      expect(def.validRange).toEqual([-1, 1]);
    }
  });
});
