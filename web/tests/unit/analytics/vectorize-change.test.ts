import { describe, expect, it } from "vitest";
import type { Ring } from "@/lib/geo";
import { alignToGrid, deltaGrid, detectNdviChange, labelComponents, newWaterCandidates } from "@/server/analytics/change";
import { GridMismatchError } from "@/server/analytics/errors";
import type { Grid } from "@/server/analytics/raster/grid";
import { transformPoint } from "@/server/analytics/raster/projection";
import { ringSignedArea, toLonLatMultiPolygon, vectorizeComponent, vectorizeMask } from "@/server/analytics/vectorize";

const PX = 10;
const gridOf = (width: number, height: number): Grid => ({ width, height, epsg: 32618, transform: [500_000, PX, 0, 4_000_000, 0, -PX] });

/** Parse ASCII art: '#' = 1. */
function art(lines: string[]): { mask: Uint8Array; width: number; height: number } {
  const width = lines[0]!.length;
  return { mask: Uint8Array.from(lines.join("").split(""), (ch) => (ch === "#" ? 1 : 0)), width, height: lines.length };
}

function polygonArea(poly: Ring[]): number {
  return poly.reduce((a, ring) => a + ringSignedArea(ring), 0);
}

function expectClosed(ring: Ring) {
  expect(ring.length).toBeGreaterThanOrEqual(5);
  expect(ring[0]).toEqual(ring[ring.length - 1]);
}

/** No vertex repeats inside a ring (other than the closing one), i.e. the ring is simple. */
function expectNoRepeatedVertex(ring: Ring) {
  const keys = ring.slice(0, -1).map((p) => p.join(","));
  expect(new Set(keys).size).toBe(keys.length);
}

function vectorize(lines: string[]) {
  const { mask, width, height } = art(lines);
  return { polys: vectorizeMask(mask, width, height, gridOf(width, height)), mask };
}

describe("vectorize", () => {
  it("traces a single pixel as one CCW square", () => {
    const { polys } = vectorize(["#"]);
    expect(polys).toHaveLength(1);
    const shell = polys[0]![0]!;
    expect(shell).toHaveLength(5);
    expectClosed(shell);
    expect(ringSignedArea(shell)).toBe(100);
    expect(shell).toContainEqual([500_000, 4_000_000]);
    expect(shell).toContainEqual([500_010, 3_999_990]);
  });

  it("removes collinear vertices", () => {
    const { polys } = vectorize(["####"]);
    expect(polys[0]![0]).toHaveLength(5);
    expect(ringSignedArea(polys[0]![0]!)).toBe(400);
  });

  it("traces an L-shape exactly along pixel edges", () => {
    const { polys } = vectorize(["#..", "#..", "###"]);
    expect(polys).toHaveLength(1);
    const shell = polys[0]![0]!;
    expect(shell).toHaveLength(7); // 6 corners + closing vertex
    expectClosed(shell);
    expect(ringSignedArea(shell)).toBe(5 * PX * PX);
  });

  it("emits holes clockwise and exteriors counter-clockwise", () => {
    const { polys } = vectorize(["###", "#.#", "###"]);
    expect(polys).toHaveLength(1);
    const [shell, hole] = polys[0]!;
    expect(polys[0]).toHaveLength(2);
    expect(ringSignedArea(shell!)).toBe(900);
    expect(ringSignedArea(hole!)).toBe(-100);
    expect(polygonArea(polys[0]!)).toBe(8 * PX * PX);
    expectClosed(hole!);
  });

  it("keeps rings simple at a saddle inside one 4-connected component", () => {
    // (1,1) and (2,2) touch only diagonally but are connected around the right side;
    // the background pixel (2,1) becomes a hole touching the shell at one vertex.
    const lines = [".###", ".#.#", "..##"];
    const { mask, width, height } = art(lines);
    const comps = labelComponents(mask, width, height);
    expect(comps.count).toBe(1);
    const polys = vectorizeComponent(comps.labels, gridOf(width, height), 1, { minCol: 0, minRow: 0, maxCol: 3, maxRow: 2 });
    expect(polys).toHaveLength(1);
    expect(polys[0]).toHaveLength(2);
    for (const ring of polys[0]!) {
      expectClosed(ring);
      expectNoRepeatedVertex(ring);
    }
    expect(polygonArea(polys[0]!)).toBe(7 * PX * PX);
  });

  it("vectorized area equals pixel_count × pixel_area for an irregular blob", () => {
    const lines = ["..####..", ".##..##.", "##.##.##", "#..##..#", "########", "...#...."];
    const { polys, mask } = vectorize(lines);
    const pixels = mask.reduce((a, b) => a + b, 0);
    expect(polys.reduce((a, p) => a + polygonArea(p), 0)).toBe(pixels * PX * PX);
    for (const p of polys) {
      expect(ringSignedArea(p[0]!)).toBeGreaterThan(0);
      for (const hole of p.slice(1)) expect(ringSignedArea(hole)).toBeLessThan(0);
    }
  });

  it("unprojects to lon/lat preserving orientation", () => {
    const { polys } = vectorize(["###", "#.#", "###"]);
    const g = toLonLatMultiPolygon(polys, 32618);
    expect(g.type).toBe("MultiPolygon");
    const [shell, hole] = g.coordinates[0]!;
    expect(ringSignedArea(shell!)).toBeGreaterThan(0);
    expect(ringSignedArea(hole!)).toBeLessThan(0);
    expect(shell![0]![0]).toBeCloseTo(-75, 6);
  });
});

describe("labelComponents", () => {
  it("keeps diagonal-touching pixels separate (4-connectivity)", () => {
    const { mask, width, height } = art(["#.", ".#"]);
    expect(labelComponents(mask, width, height).count).toBe(2);
  });

  it("merges U-shapes discovered as separate provisional labels", () => {
    const { mask, width, height } = art(["#.#.#", "#.#.#", "#####"]);
    const { labels, count } = labelComponents(mask, width, height);
    expect(count).toBe(1);
    expect(new Set(labels.filter((l) => l > 0))).toEqual(new Set([1]));
  });

  it("labels a 2000 × 2000 serpentine (one component, 2 M pixels) without recursion", () => {
    const w = 2000;
    const h = 2000;
    const mask = new Uint8Array(w * h);
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const i = r * w + c;
        if (r % 2 === 0) mask[i] = 1;
        else if ((r % 4 === 1 && c === w - 1) || (r % 4 === 3 && c === 0)) mask[i] = 1;
      }
    }
    const { count } = labelComponents(mask, w, h);
    expect(count).toBe(1);
  });
});

describe("change detection", () => {
  const W = 20;
  const H = 20;
  const G = gridOf(W, H);

  function scenario() {
    const before = new Float32Array(W * H).fill(0.6);
    const after = new Float32Array(W * H).fill(0.6);
    const set = (arr: Float32Array, c0: number, r0: number, c1: number, r1: number, v: number) => {
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) arr[r * W + c] = v;
    };
    set(after, 2, 2, 4, 4, 0.2); // A: 3×3 decrease Δ = −0.4 …
    before[3 * W + 3] = Number.NaN; // … with an invalid centre → ring with a hole
    set(after, 10, 10, 11, 14, 0.9); // C: 2×5 increase Δ = +0.3 (1000 m²)
    after[18 * W + 18] = 0.1; // B: single pixel decrease (100 m²)
    set(after, 15, 2, 17, 4, 0.7); // small Δ = +0.1, below threshold
    after[2 * W + 6] = 0.2; // diagonal neighbour of nothing, but…
    after[3 * W + 7] = 0.2; // …touching (6,2) only at a corner: two 1-pixel components
    const inside = new Uint8Array(W * H).fill(1);
    return { before, after, inside };
  }

  it("splits by direction, filters by area, vectorizes with holes", () => {
    const { before, after, inside } = scenario();
    const res = detectNdviChange({ before, after, grid: G, inside, minAreaM2: 200, daysBetween: 12 });
    expect(res.candidates).toHaveLength(2);
    expect(res.belowMinArea).toBe(3); // B and the two diagonal singletons
    expect(res.omitted).toBe(0);
    const [first, second] = res.candidates;
    expect(first!.metrics).toMatchObject({ direction: "increase", pixel_count: 10, area_m2: 1000, days_between: 12, same_grid: true });
    expect(first!.metrics.mean_delta).toBeCloseTo(0.3, 5);
    expect(second!.metrics).toMatchObject({ direction: "decrease", pixel_count: 8, area_m2: 800 });
    expect(second!.metrics.mean_delta).toBeCloseTo(-0.4, 5);
    expect(second!.metrics.min_delta).toBeCloseTo(-0.4, 5);
    expect(second!.metrics.max_delta).toBeCloseTo(-0.4, 5);
    expect(res.validOverlapFraction).toBeCloseTo(399 / 400, 10);
    expect(second!.metrics.valid_overlap_fraction).toBeCloseTo(399 / 400, 10);

    const poly = second!.geometry.coordinates[0]!;
    expect(poly).toHaveLength(2); // the NaN pixel is a hole
    expect(ringSignedArea(poly[0]!)).toBeGreaterThan(0);
    expect(ringSignedArea(poly[1]!)).toBeLessThan(0);
    for (const ring of poly) expectClosed(ring);
    const [w, s, e, n] = second!.bbox;
    expect(w).toBeLessThan(e);
    expect(s).toBeLessThan(n);
  });

  it("caps candidates and reports how many were omitted", () => {
    const { before, after, inside } = scenario();
    const res = detectNdviChange({ before, after, grid: G, inside, minAreaM2: 0, daysBetween: 1, maxCandidates: 2 });
    expect(res.candidates).toHaveLength(2);
    expect(res.omitted).toBe(3);
    // Diagonal pixels are separate candidates when not filtered.
    const all = detectNdviChange({ before, after, grid: G, inside, minAreaM2: 0, daysBetween: 1 });
    expect(all.candidates.filter((c) => c.metrics.pixel_count === 1)).toHaveLength(3);
  });

  it("ignores pixels outside the AOI and with NaN in either date", () => {
    const { before, after } = scenario();
    const inside = new Uint8Array(W * H);
    for (let r = 0; r < H; r++) for (let c = 0; c < 8; c++) inside[r * W + c] = 1; // left 8 columns only
    const res = detectNdviChange({ before, after, grid: G, inside, minAreaM2: 200, daysBetween: 5, sameGrid: false });
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0]!.metrics.direction).toBe("decrease");
    expect(res.candidates[0]!.metrics.same_grid).toBe(false);
    expect(res.insidePixels).toBe(160);
    expect(res.validOverlapPixels).toBe(159);
  });

  it("rejects grids of different sizes", () => {
    expect(() => deltaGrid(new Float32Array(4), new Float32Array(5))).toThrow(GridMismatchError);
  });

  it("finds new-water regions only where both observations are valid", () => {
    const n = W * H;
    const before = new Uint8Array(n);
    const after = new Uint8Array(n);
    const valid = new Uint8Array(n).fill(1);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) after[r * W + c] = 1; // 16 px newly wet
    for (let r = 10; r < 12; r++) {
      for (let c = 10; c < 12; c++) {
        before[r * W + c] = 1; // permanent water
        after[r * W + c] = 1;
      }
    }
    for (let c = 15; c < 20; c++) {
      after[19 * W + c] = 1; // wet, but invalid in one date
      valid[19 * W + c] = 0;
    }
    const res = newWaterCandidates(before, after, valid, G, 500, { inside: new Uint8Array(n).fill(1), daysBetween: 6 });
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0]!.metrics).toMatchObject({ direction: "new_water", pixel_count: 16, area_m2: 1600, days_between: 6 });
    expect(res.candidates[0]!.metrics.mean_delta).toBeUndefined();
    expect(res.validOverlapFraction).toBeCloseTo(395 / 400, 10);
  });
});

describe("alignToGrid", () => {
  it("shifts by whole pixels on a shared lattice", () => {
    const from = gridOf(3, 1);
    const to: Grid = { ...from, transform: [500_010, PX, 0, 4_000_000, 0, -PX] };
    const out = alignToGrid(Float32Array.from([1, 2, 3]), from, to);
    expect(Array.from(out.slice(0, 2))).toEqual([2, 3]);
    expect(Number.isNaN(out[2]!)).toBe(true);
  });

  it("reprojects between UTM zones by nearest neighbour", () => {
    const from: Grid = { width: 50, height: 50, epsg: 32618, transform: [270_000, 10, 0, 3_975_000, 0, -10] };
    const values = new Float32Array(2500).fill(0.5);
    const to: Grid = { width: 10, height: 10, epsg: 32617, transform: [0, 10, 0, 0, 0, -10] };
    // Place the target grid over the middle of `from` in zone 17 coordinates.
    const [x, y] = transformPoint(32618, 32617, [270_200, 3_974_800]);
    to.transform = [x, 10, 0, y, 0, -10];
    const out = alignToGrid(values, from, to);
    expect(Array.from(out).every((v) => v === 0.5)).toBe(true);
  });
});
