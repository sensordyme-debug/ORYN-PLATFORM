/**
 * Change candidates between two observations on one grid.
 *
 * NDVI change (analytic "ndvi-change"): Δ = after − before on pixels valid in
 * both (and inside the AOI). Pixels with Δ ≤ −threshold form the "decrease"
 * mask, Δ ≥ +threshold the "increase" mask. Each mask is split into
 * 4-connected components (two-pass union-find, no recursion — safe for 25 M
 * pixels); components smaller than minAreaM2 (sum of per-row pixel areas) are
 * dropped; the rest are vectorized exactly along pixel edges (vectorize.ts)
 * and unprojected to lon/lat.
 *
 * Water change ("water-change"): pixels that are water in `after`, not water
 * in `before`, and valid in both → "new_water" components, same pipeline.
 *
 * Grids: the two inputs must be on the SAME grid. alignToGrid resamples a
 * grid onto another (nearest neighbour on pixel centres) when the caller
 * cannot guarantee that; such results must be reported with same_grid=false.
 *
 * Output is capped at maxCandidates (default 500, largest first); the number
 * of further qualifying components is reported as `omitted`, never hidden.
 */
import type { BBox, MultiPolygonGeometry } from "@/lib/geo";
import type { ChangeMetrics } from "./types";
import { GridMismatchError, InvalidInputError } from "./errors";
import { rowAreasM2, sameGrid, type Grid } from "./raster/grid";
import { transformPoint } from "./raster/projection";
import { toLonLatMultiPolygon, vectorizeComponent, type PixelBBox } from "./vectorize";

export const DEFAULT_NDVI_CHANGE_THRESHOLD = 0.2;
export const DEFAULT_MAX_CANDIDATES = 500;

export type ChangeDirection = ChangeMetrics["direction"];

export type ChangeCandidate = {
  geometry: MultiPolygonGeometry;
  metrics: ChangeMetrics;
  /** Lon/lat bounding box [west, south, east, north]. */
  bbox: BBox;
  pixelBBox: PixelBBox;
};

export type ChangeResult = {
  candidates: ChangeCandidate[];
  /** Qualifying components beyond maxCandidates (not vectorized). */
  omitted: number;
  /** Components dropped for being smaller than minAreaM2. */
  belowMinArea: number;
  insidePixels: number;
  validOverlapPixels: number;
  validOverlapFraction: number;
};

export type ComponentLabels = { labels: Int32Array; count: number };

export type ComponentStats = {
  label: number;
  pixelCount: number;
  areaM2: number;
  meanDelta: number | null;
  minDelta: number | null;
  maxDelta: number | null;
  bbox: PixelBBox;
};

/** Δ = after − before where both are finite (and inside, when given); NaN elsewhere. */
export function deltaGrid(
  before: Float32Array,
  after: Float32Array,
  inside?: Uint8Array | null,
): { delta: Float32Array; validBoth: Uint8Array; validCount: number } {
  if (before.length !== after.length || (inside && inside.length !== before.length)) {
    throw new GridMismatchError("deltaGrid requires both observations on the same grid (array lengths differ).");
  }
  const delta = new Float32Array(before.length);
  const validBoth = new Uint8Array(before.length);
  let validCount = 0;
  for (let i = 0; i < before.length; i++) {
    const a = before[i]!;
    const b = after[i]!;
    if ((inside && !inside[i]) || !Number.isFinite(a) || !Number.isFinite(b)) {
      delta[i] = Number.NaN;
      continue;
    }
    delta[i] = b - a;
    validBoth[i] = 1;
    validCount++;
  }
  return { delta, validBoth, validCount };
}

/**
 * Resample `values` from `fromGrid` onto `toGrid` by nearest neighbour on
 * target pixel centres; NaN where the centre falls outside `fromGrid`.
 * Different CRSs are handled by transforming every target centre (exact but
 * slower: one proj4 call per pixel).
 */
export function alignToGrid(values: Float32Array, fromGrid: Grid, toGrid: Grid): Float32Array {
  if (values.length !== fromGrid.width * fromGrid.height) throw new GridMismatchError("values length does not match fromGrid.");
  if (sameGrid(fromGrid, toGrid)) return Float32Array.from(values);
  const out = new Float32Array(toGrid.width * toGrid.height).fill(Number.NaN);
  const [fox, fpw, , foy, , fnph] = fromGrid.transform;
  const fph = -fnph;
  const [tox, tpw, , toy, , tnph] = toGrid.transform;
  const reproject = fromGrid.epsg !== toGrid.epsg;
  for (let r = 0; r < toGrid.height; r++) {
    for (let c = 0; c < toGrid.width; c++) {
      let x = tox + (c + 0.5) * tpw;
      let y = toy + (r + 0.5) * tnph;
      if (reproject) [x, y] = transformPoint(toGrid.epsg, fromGrid.epsg, [x, y]);
      const sc = Math.floor((x - fox) / fpw);
      const sr = Math.floor((foy - y) / fph);
      if (sc >= 0 && sr >= 0 && sc < fromGrid.width && sr < fromGrid.height) out[r * toGrid.width + c] = values[sr * fromGrid.width + sc]!;
    }
  }
  return out;
}

/** 4-connected component labelling (labels 1..count, 0 = background). Iterative two-pass union-find. */
export function labelComponents(mask: Uint8Array, width: number, height: number): ComponentLabels {
  if (mask.length !== width * height) throw new GridMismatchError("mask length does not match width × height.");
  const labels = new Int32Array(mask.length);
  let parent = new Int32Array(1024);
  let next = 1;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!; // path halving
      x = parent[x]!;
    }
    return x;
  };
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const i = r * width + c;
      if (!mask[i]) continue;
      const up = r > 0 ? labels[i - width]! : 0;
      const left = c > 0 ? labels[i - 1]! : 0;
      if (up && left) {
        const ru = find(up);
        const rl = find(left);
        if (ru !== rl) parent[Math.max(ru, rl)] = Math.min(ru, rl);
        labels[i] = Math.min(ru, rl);
      } else if (up || left) {
        labels[i] = up || left;
      } else {
        if (next >= parent.length) {
          const grown = new Int32Array(parent.length * 2);
          grown.set(parent);
          parent = grown;
        }
        parent[next] = next;
        labels[i] = next++;
      }
    }
  }
  // Resolve to compact final labels in scan order.
  const finalOf = new Int32Array(next);
  let count = 0;
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]!;
    if (!l) continue;
    const root = find(l);
    if (!finalOf[root]) finalOf[root] = ++count;
    labels[i] = finalOf[root]!;
  }
  return { labels, count };
}

/** Per-component pixel count, area (per-row pixel areas), Δ statistics, and pixel bbox. */
export function componentStats({ labels, count }: ComponentLabels, grid: Grid, delta?: Float32Array | null): ComponentStats[] {
  const n = new Float64Array(count + 1);
  const area = new Float64Array(count + 1);
  const sum = new Float64Array(count + 1);
  const nd = new Float64Array(count + 1);
  const min = new Float64Array(count + 1).fill(Infinity);
  const max = new Float64Array(count + 1).fill(-Infinity);
  const minCol = new Int32Array(count + 1).fill(grid.width);
  const minRow = new Int32Array(count + 1).fill(grid.height);
  const maxCol = new Int32Array(count + 1).fill(-1);
  const maxRow = new Int32Array(count + 1).fill(-1);
  const rowArea = rowAreasM2(grid);
  for (let r = 0; r < grid.height; r++) {
    const a = rowArea[r]!;
    for (let c = 0; c < grid.width; c++) {
      const i = r * grid.width + c;
      const l = labels[i]!;
      if (!l) continue;
      n[l] = n[l]! + 1;
      area[l] = area[l]! + a;
      if (c < minCol[l]!) minCol[l] = c;
      if (c > maxCol[l]!) maxCol[l] = c;
      if (r < minRow[l]!) minRow[l] = r;
      if (r > maxRow[l]!) maxRow[l] = r;
      const d = delta ? delta[i]! : Number.NaN;
      if (Number.isFinite(d)) {
        sum[l] = sum[l]! + d;
        nd[l] = nd[l]! + 1;
        if (d < min[l]!) min[l] = d;
        if (d > max[l]!) max[l] = d;
      }
    }
  }
  const out: ComponentStats[] = [];
  for (let l = 1; l <= count; l++) {
    const hasDelta = nd[l]! > 0;
    out.push({
      label: l,
      pixelCount: n[l]!,
      areaM2: area[l]!,
      meanDelta: hasDelta ? sum[l]! / nd[l]! : null,
      minDelta: hasDelta ? min[l]! : null,
      maxDelta: hasDelta ? max[l]! : null,
      bbox: { minCol: minCol[l]!, minRow: minRow[l]!, maxCol: maxCol[l]!, maxRow: maxRow[l]! },
    });
  }
  return out;
}

function lonLatBBox(g: MultiPolygonGeometry): BBox {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const poly of g.coordinates) {
    for (const p of poly[0] ?? []) {
      if (p[0] < w) w = p[0];
      if (p[0] > e) e = p[0];
      if (p[1] < s) s = p[1];
      if (p[1] > n) n = p[1];
    }
  }
  return [w, s, e, n];
}

type CandidateContext = {
  grid: Grid;
  minAreaM2: number;
  daysBetween: number;
  sameGrid: boolean;
  validOverlapFraction: number;
  maxCandidates: number;
};

/** Components of `mask` → filtered, vectorized candidates. */
function candidatesFromMask(mask: Uint8Array, direction: ChangeDirection, ctx: CandidateContext, delta: Float32Array | null) {
  const comps = labelComponents(mask, ctx.grid.width, ctx.grid.height);
  const stats = componentStats(comps, ctx.grid, delta);
  const kept = stats.filter((s) => s.areaM2 >= ctx.minAreaM2);
  const build = (s: ComponentStats): ChangeCandidate => {
    const geometry = toLonLatMultiPolygon(vectorizeComponent(comps.labels, ctx.grid, s.label, s.bbox), ctx.grid.epsg);
    const metrics: ChangeMetrics = {
      pixel_count: s.pixelCount,
      area_m2: s.areaM2,
      direction,
      valid_overlap_fraction: ctx.validOverlapFraction,
      days_between: ctx.daysBetween,
      same_grid: ctx.sameGrid,
    };
    if (s.meanDelta !== null) {
      metrics.mean_delta = s.meanDelta;
      metrics.min_delta = s.minDelta!;
      metrics.max_delta = s.maxDelta!;
    }
    return { geometry, metrics, bbox: lonLatBBox(geometry), pixelBBox: s.bbox };
  };
  return { kept, belowMinArea: stats.length - kept.length, build };
}

function finish(
  groups: ReturnType<typeof candidatesFromMask>[],
  ctx: CandidateContext,
  insidePixels: number,
  validOverlapPixels: number,
): ChangeResult {
  const all = groups.flatMap((g) => g.kept.map((s) => ({ s, build: g.build })));
  all.sort((a, b) => b.s.areaM2 - a.s.areaM2 || a.s.label - b.s.label);
  const chosen = all.slice(0, ctx.maxCandidates);
  return {
    candidates: chosen.map(({ s, build }) => build(s)),
    omitted: all.length - chosen.length,
    belowMinArea: groups.reduce((n, g) => n + g.belowMinArea, 0),
    insidePixels,
    validOverlapPixels,
    validOverlapFraction: ctx.validOverlapFraction,
  };
}

function countOnes(m: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < m.length; i++) if (m[i]) n++;
  return n;
}

function checkParams(minAreaM2: number, daysBetween: number) {
  if (!(minAreaM2 >= 0) || !Number.isFinite(minAreaM2)) throw new InvalidInputError("invalid_min_area", "minAreaM2 must be a finite number ≥ 0.");
  if (!Number.isFinite(daysBetween)) throw new InvalidInputError("invalid_days_between", "daysBetween must be finite.");
}

/**
 * NDVI change candidates. `before`/`after` are NDVI grids on `grid` (NaN = no
 * value); `inside` is the AOI mask on the same grid.
 */
export function detectNdviChange(params: {
  before: Float32Array;
  after: Float32Array;
  grid: Grid;
  inside: Uint8Array;
  threshold?: number;
  minAreaM2: number;
  daysBetween: number;
  sameGrid?: boolean;
  maxCandidates?: number;
}): ChangeResult & { delta: Float32Array; validBoth: Uint8Array } {
  const { grid, inside } = params;
  const n = grid.width * grid.height;
  if (params.before.length !== n || params.after.length !== n || inside.length !== n) {
    throw new GridMismatchError("NDVI grids and AOI mask must all match the grid size.");
  }
  checkParams(params.minAreaM2, params.daysBetween);
  const t = params.threshold ?? DEFAULT_NDVI_CHANGE_THRESHOLD;
  if (!(t > 0)) throw new InvalidInputError("invalid_threshold", "The change threshold must be > 0.");
  const { delta, validBoth, validCount } = deltaGrid(params.before, params.after, inside);
  const insidePixels = countOnes(inside);
  const ctx: CandidateContext = {
    grid,
    minAreaM2: params.minAreaM2,
    daysBetween: params.daysBetween,
    sameGrid: params.sameGrid ?? true,
    validOverlapFraction: insidePixels > 0 ? validCount / insidePixels : 0,
    maxCandidates: params.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
  };
  const decrease = new Uint8Array(n);
  const increase = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const d = delta[i]!;
    if (d <= -t) decrease[i] = 1;
    else if (d >= t) increase[i] = 1;
  }
  const result = finish(
    [candidatesFromMask(decrease, "decrease", ctx, delta), candidatesFromMask(increase, "increase", ctx, delta)],
    ctx,
    insidePixels,
    validCount,
  );
  return { ...result, delta, validBoth };
}

/**
 * Newly wet pixels: water in `maskAfter`, not water in `maskBefore`, valid in
 * both (`validBoth`, already restricted to the AOI). Direction "new_water".
 */
export function newWaterCandidates(
  maskBefore: Uint8Array,
  maskAfter: Uint8Array,
  validBoth: Uint8Array,
  grid: Grid,
  minAreaM2: number,
  opts: { inside: Uint8Array; daysBetween: number; sameGrid?: boolean; maxCandidates?: number },
): ChangeResult {
  const n = grid.width * grid.height;
  if (maskBefore.length !== n || maskAfter.length !== n || validBoth.length !== n || opts.inside.length !== n) {
    throw new GridMismatchError("Water masks must all match the grid size.");
  }
  checkParams(minAreaM2, opts.daysBetween);
  const wet = new Uint8Array(n);
  let validCount = 0;
  for (let i = 0; i < n; i++) {
    if (!validBoth[i] || !opts.inside[i]) continue;
    validCount++;
    if (maskAfter[i] && !maskBefore[i]) wet[i] = 1;
  }
  const insidePixels = countOnes(opts.inside);
  const ctx: CandidateContext = {
    grid,
    minAreaM2,
    daysBetween: opts.daysBetween,
    sameGrid: opts.sameGrid ?? true,
    validOverlapFraction: insidePixels > 0 ? validCount / insidePixels : 0,
    maxCandidates: opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
  };
  return finish([candidatesFromMask(wet, "new_water", ctx, null)], ctx, insidePixels, validCount);
}

