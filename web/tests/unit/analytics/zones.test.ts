/**
 * Within-field low-vigour zones (ndvi-zones 1.0.0): robust field statistics,
 * zone delineation and ranking, applicability guards, masked-edge flag,
 * persistence, and evidence grading.
 */
import { describe, expect, it } from "vitest";
import type { Grid } from "@/server/analytics/raster/grid";
import { detectLowVigorZones, gradeZone, robustFieldStats, zonePersistence, ZONE_DEFAULTS } from "@/server/analytics/zones";

const W = 60;
const H = 60;
const grid: Grid = { width: W, height: H, epsg: 32618, transform: [500_000, 10, 0, 4_000_000, 0, -10] };

/** Deterministic small "noise" in [−0.02, 0.02] so the field is not perfectly flat. */
const noise = (i: number) => (((i * 2654435761) >>> 0) % 401) / 10_000 - 0.02;

function field(base = 0.7, patches: { r0: number; c0: number; size: number; value: number }[] = []) {
  const v = new Float32Array(W * H);
  for (let i = 0; i < v.length; i++) v[i] = base + noise(i);
  for (const p of patches) {
    for (let r = p.r0; r < p.r0 + p.size; r++) for (let c = p.c0; c < p.c0 + p.size; c++) v[r * W + c] = p.value + noise(r * W + c);
  }
  return v;
}

describe("ndvi-zones", () => {
  it("computes the median and robust sigma (1.4826 · MAD) over valid pixels inside the AOI", () => {
    const v = new Float32Array([0.5, 0.6, 0.7, 0.8, Number.NaN, 0.1]);
    const inside = new Uint8Array([1, 1, 1, 1, 1, 0]);
    const s = robustFieldStats(v, inside, ZONE_DEFAULTS)!;
    expect(s.validPixels).toBe(4);
    expect(s.validFraction).toBeCloseTo(4 / 5, 10);
    expect(s.median).toBeCloseTo(0.65, 6);
    expect(s.robustSigma).toBeCloseTo(1.4826 * 0.1, 5);
    expect(s.threshold).toBeCloseTo(0.65 - Math.max(1.5 * 1.4826 * 0.1, 0.1), 5);
  });

  it("finds a localized low-NDVI zone, drops zones below the minimum area, and ranks by area × deficit", () => {
    // 8×8 px (6,400 m²) at 0.40 and 10×10 px (10,000 m²) at 0.55 in a 0.70 field; a 3×3 px (900 m²) patch is too small.
    const v = field(0.7, [
      { r0: 5, c0: 5, size: 8, value: 0.4 },
      { r0: 30, c0: 30, size: 10, value: 0.55 },
      { r0: 50, c0: 50, size: 3, value: 0.2 },
    ]);
    const r = detectLowVigorZones({ values: v, inside: null, grid });
    if (r.status !== "valid") throw new Error(r.reason);
    expect(r.field.median).toBeGreaterThan(0.68);
    expect(r.zones).toHaveLength(2);
    expect(r.belowMinArea).toBeGreaterThanOrEqual(1);
    const [first, second] = r.zones;
    // 0.64 ha × 0.30 = 0.19 outranks 1.0 ha × 0.15 = 0.15.
    expect(first!.metrics).toMatchObject({ rank: 1, pixel_count: 64, area_m2: 6_400 });
    expect(first!.metrics.mean_ndvi).toBeCloseTo(0.4, 1);
    expect(first!.metrics.deficit).toBeCloseTo(0.3, 1);
    expect(second!.metrics).toMatchObject({ rank: 2, pixel_count: 100, area_m2: 10_000 });
    expect(first!.metrics.edge_masked_fraction).toBe(0);
    // Geometry: lon/lat polygon around the zone.
    expect(first!.geometry.type).toBe("MultiPolygon");
    expect(first!.bbox[0]).toBeLessThan(first!.bbox[2]);
  });

  it("reports nothing in a uniform field", () => {
    const r = detectLowVigorZones({ values: field(0.7), inside: null, grid });
    expect(r.status).toBe("valid");
    if (r.status === "valid") expect(r.zones).toHaveLength(0);
  });

  it("is not applicable for bare or harvested ground, or when too much of the area is masked", () => {
    const bare = detectLowVigorZones({ values: field(0.18, [{ r0: 5, c0: 5, size: 10, value: 0.05 }]), inside: null, grid });
    expect(bare).toMatchObject({ status: "not_applicable", reason: expect.stringMatching(/median NDVI is 0\.1\d/) });

    const cloudy = field(0.7, [{ r0: 5, c0: 5, size: 10, value: 0.4 }]);
    for (let i = 0; i < cloudy.length * 0.4; i++) cloudy[i] = Number.NaN;
    expect(detectLowVigorZones({ values: cloudy, inside: null, grid })).toMatchObject({ status: "not_applicable", reason: expect.stringMatching(/Only 60% of the area was usable/) });
  });

  it("measures how much of a zone's edge is the area boundary", () => {
    // AOI = all but the outer ring of pixels; a 6×6 low patch in the AOI's north-west corner.
    const inside = new Uint8Array(W * H);
    for (let r = 1; r < H - 1; r++) for (let c = 1; c < W - 1; c++) inside[r * W + c] = 1;
    const v = field(0.7, [{ r0: 1, c0: 1, size: 6, value: 0.4 }]);
    const r = detectLowVigorZones({ values: v, inside, grid });
    if (r.status !== "valid") throw new Error(r.reason);
    // 24 edge neighbours, 12 on the north and west sides are outside the AOI.
    expect(r.zones[0]!.metrics.boundary_edge_fraction).toBeCloseTo(0.5, 10);
    expect(r.zones[0]!.metrics.edge_masked_fraction).toBe(0);
  });

  it("flags zones bordering masked pixels (possible residual cloud shadow)", () => {
    const v = field(0.7, [{ r0: 20, c0: 20, size: 8, value: 0.4 }]);
    // Masked pixels along the zone's east and north sides: 16 of its 32 edge neighbours.
    for (let r = 20; r < 28; r++) v[r * W + 28] = Number.NaN;
    for (let c = 20; c < 28; c++) v[19 * W + c] = Number.NaN;
    const r = detectLowVigorZones({ values: v, inside: null, grid });
    if (r.status !== "valid") throw new Error(r.reason);
    expect(r.zones[0]!.metrics.edge_masked_fraction).toBeCloseTo(0.5, 10);
    const g = gradeZone(r.zones[0]!.metrics, { maskedFraction: 0.01, persistence: { state: "unknown", reason: "No earlier image." } });
    expect(g.grade).toBe("weak");
    expect(g.reasons.join(" ")).toMatch(/50% of the zone's edge borders cloud-, shadow-, or no-data-masked pixels/);
  });

  it("checks persistence against an earlier image with that image's own threshold", () => {
    const now = field(0.7, [{ r0: 5, c0: 5, size: 8, value: 0.4 }]);
    const r = detectLowVigorZones({ values: now, inside: null, grid });
    if (r.status !== "valid") throw new Error(r.reason);
    const z = r.zones[0]!;
    const priorLow = field(0.6, [{ r0: 5, c0: 5, size: 8, value: 0.35 }]);
    const tLow = robustFieldStats(priorLow, null, ZONE_DEFAULTS)!.threshold;
    expect(zonePersistence(r.labels.labels, z.label, z.pixelBBox, W, priorLow, tLow, "2026-07-01")).toMatchObject({ state: "persistent", lowShare: 1 });
    const priorFine = field(0.6);
    const tFine = robustFieldStats(priorFine, null, ZONE_DEFAULTS)!.threshold;
    expect(zonePersistence(r.labels.labels, z.label, z.pixelBBox, W, priorFine, tFine, "2026-07-01")).toMatchObject({ state: "not_persistent", lowShare: 0 });
    const priorCloudy = field(0.6);
    for (let rr = 5; rr < 13; rr++) for (let c = 5; c < 13; c++) priorCloudy[rr * W + c] = Number.NaN;
    expect(zonePersistence(r.labels.labels, z.label, z.pixelBBox, W, priorCloudy, tFine, "2026-07-01")).toMatchObject({ state: "unknown" });
  });

  it("grades by deficit, size, masking, and persistence — never higher than the evidence allows", () => {
    const base = { rank: 1, pixel_count: 64, area_m2: 6_400, mean_ndvi: 0.45, min_ndvi: 0.3, field_median: 0.7, deficit: 0.25, relative_deficit: 0.36, threshold: 0.6, score: 0.16, edge_masked_fraction: 0, boundary_edge_fraction: 0, share_of_valid_area: 0.02 };
    const unknown = { state: "unknown" as const, reason: "No earlier usable image within 45 days to check persistence." };
    expect(gradeZone(base, { maskedFraction: 0, persistence: unknown }).grade).toBe("strong");
    expect(gradeZone({ ...base, deficit: 0.14 }, { maskedFraction: 0, persistence: unknown }).grade).toBe("moderate");
    expect(gradeZone({ ...base, deficit: 0.11 }, { maskedFraction: 0, persistence: unknown }).grade).toBe("weak");
    expect(gradeZone({ ...base, pixel_count: 20 }, { maskedFraction: 0, persistence: unknown }).grade).toBe("weak");
    expect(gradeZone(base, { maskedFraction: 0.3, persistence: unknown }).grade).toBe("moderate");
    const atEdge = gradeZone({ ...base, boundary_edge_fraction: 0.5 }, { maskedFraction: 0, persistence: unknown });
    expect(atEdge.grade).toBe("moderate");
    expect(atEdge.reasons.join(" ")).toMatch(/50% of the zone's edge is the area's boundary/);
    // Persistence cannot vouch for a boundary zone: the neighbouring road is in every image too.
    const persistentAtEdge = gradeZone({ ...base, boundary_edge_fraction: 0.5 }, { maskedFraction: 0, persistence: { state: "persistent", date: "2026-07-01", lowShare: 1, coveredShare: 1 } });
    expect(persistentAtEdge.grade).toBe("moderate");
    const persistent = { state: "persistent" as const, date: "2026-07-01", lowShare: 0.9, coveredShare: 1 };
    expect(gradeZone({ ...base, deficit: 0.11 }, { maskedFraction: 0, persistence: persistent })).toMatchObject({ grade: "moderate", reasons: expect.arrayContaining([expect.stringMatching(/Also low in the previous usable image \(2026-07-01\)/)]) });
    const transient = { state: "not_persistent" as const, date: "2026-07-01", lowShare: 0.1, coveredShare: 1 };
    expect(gradeZone(base, { maskedFraction: 0, persistence: transient }).grade).toBe("moderate");
  });
});
