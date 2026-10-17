/**
 * Within-field low-vigour zones (analytic "ndvi-zones" 1.0.0): localized
 * areas whose NDVI is low relative to the rest of the same area on the same
 * date.
 *
 *   median m, robust sigma s = 1.4826 · MAD over the AOI's valid pixels
 *   threshold t = m − max(k · s, minDeficit)          (k = 1.5, minDeficit 0.10)
 *   low pixels: valid and NDVI < t → 4-connected zones (labelComponents)
 *   zones under minAreaM2 (2,000 m²) are dropped; the rest are ranked by
 *   score = area (ha) × deficit, where deficit = m − zone mean NDVI.
 *
 * Applicability: the image must cover at least 70 % of the area with valid
 * pixels, with at least 100 valid pixels, and the area's median NDVI must be
 * ≥ 0.3 — below that (bare soil, before emergence, after harvest) relative
 * differences carry no meaning and nothing is reported.
 *
 * Each zone records how much of its edge borders masked (cloud, shadow, no
 * data) pixels — residual cloud shadow at mask edges is the most common false
 * low-NDVI pattern — and how much of it is the area's own boundary, where
 * 10–30 m pixels mix with neighbouring land. Persistence against an earlier image (zonePersistence)
 * applies the same rule to that image's own NDVI on the same pixels.
 *
 * Pure functions; the job (src/server/pipeline/zones.ts) loads grids and
 * stores results.
 */
import type { BBox, MultiPolygonGeometry } from "@/lib/geo";
import { InvalidInputError } from "./errors";
import { componentStats, labelComponents, type ComponentLabels } from "./change";
import { rowAreasM2, type Grid } from "./raster/grid";
import { toLonLatMultiPolygon, vectorizeComponent, type PixelBBox } from "./vectorize";

export const ZONE_DEFAULTS = {
  k: 1.5,
  minDeficit: 0.1,
  minAreaM2: 2_000,
  minValidFraction: 0.7,
  minValidPixels: 100,
  minMedianNdvi: 0.3,
  maxZones: 50,
} as const;
export type ZoneParams = { [K in keyof typeof ZONE_DEFAULTS]: number };

export type FieldStats = { median: number; robustSigma: number; threshold: number; validPixels: number; validFraction: number };

export type ZoneMetrics = {
  rank: number;
  pixel_count: number;
  area_m2: number;
  mean_ndvi: number;
  min_ndvi: number;
  field_median: number;
  /** field median − zone mean NDVI (> 0). */
  deficit: number;
  /** deficit / field median. */
  relative_deficit: number;
  threshold: number;
  /** area in hectares × deficit; the ranking key. */
  score: number;
  /** Share of the zone's outer edge that borders masked (no-value) pixels inside the AOI. */
  edge_masked_fraction: number;
  /** Share of the zone's outer edge that is the AOI boundary (pixels there mix with neighbouring land). */
  boundary_edge_fraction: number;
  /** Zone area / valid area of the AOI. */
  share_of_valid_area: number;
};

export type Zone = { geometry: MultiPolygonGeometry; bbox: BBox; pixelBBox: PixelBBox; label: number; metrics: ZoneMetrics };

export type ZonesResult =
  | { status: "not_applicable"; reason: string; field: FieldStats | null }
  | {
      status: "valid";
      field: FieldStats;
      zones: Zone[];
      /** Qualifying zones beyond maxZones (not vectorized). */
      omitted: number;
      belowMinArea: number;
      /** Share of valid pixels below the threshold (before the area filter). */
      lowFraction: number;
      labels: ComponentLabels;
    };

/** Median of a Float64Array (sorted copy). */
function medianOf(sorted: Float64Array): number {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) >> 1]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

/** Median and robust sigma (1.4826 · MAD) of the finite values inside the AOI. */
export function robustFieldStats(values: Float32Array, inside: Uint8Array | null, params: Pick<ZoneParams, "k" | "minDeficit">): FieldStats | null {
  let insideCount = 0;
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    if (inside && !inside[i]) continue;
    insideCount++;
    if (Number.isFinite(values[i]!)) n++;
  }
  if (n === 0) return null;
  const v = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < values.length; i++) {
    if (inside && !inside[i]) continue;
    const x = values[i]!;
    if (Number.isFinite(x)) v[j++] = x;
  }
  v.sort();
  const median = medianOf(v);
  for (let i = 0; i < n; i++) v[i] = Math.abs(v[i]! - median);
  v.sort();
  const robustSigma = 1.4826 * medianOf(v);
  return { median, robustSigma, threshold: median - Math.max(params.k * robustSigma, params.minDeficit), validPixels: n, validFraction: n / insideCount };
}

function lonLatBBox(g: MultiPolygonGeometry): BBox {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let nn = -Infinity;
  for (const poly of g.coordinates) {
    for (const p of poly[0] ?? []) {
      if (p[0] < w) w = p[0];
      if (p[0] > e) e = p[0];
      if (p[1] < s) s = p[1];
      if (p[1] > nn) nn = p[1];
    }
  }
  return [w, s, e, nn];
}

/**
 * Per label, over the zone's 4-neighbour edge (neighbours not in the zone):
 *  masked   share of edge neighbours inside the AOI that have no value;
 *  boundary share of all edge neighbours that are outside the AOI (or the grid).
 */
function edgeFractions(labels: Int32Array, count: number, values: Float32Array, inside: Uint8Array | null, width: number, height: number) {
  const insideEdges = new Float64Array(count + 1);
  const masked = new Float64Array(count + 1);
  const outside = new Float64Array(count + 1);
  const check = (l: number, j: number) => {
    if (j < 0) {
      outside[l] = outside[l]! + 1;
      return;
    }
    if (labels[j] === l) return;
    if (inside && !inside[j]) {
      outside[l] = outside[l]! + 1;
      return;
    }
    insideEdges[l] = insideEdges[l]! + 1;
    if (!Number.isFinite(values[j]!)) masked[l] = masked[l]! + 1;
  };
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const i = r * width + c;
      const l = labels[i]!;
      if (!l) continue;
      check(l, c > 0 ? i - 1 : -1);
      check(l, c < width - 1 ? i + 1 : -1);
      check(l, r > 0 ? i - width : -1);
      check(l, r < height - 1 ? i + width : -1);
    }
  }
  const maskedShare = new Float64Array(count + 1);
  const boundaryShare = new Float64Array(count + 1);
  for (let l = 1; l <= count; l++) {
    maskedShare[l] = insideEdges[l]! > 0 ? masked[l]! / insideEdges[l]! : 0;
    const all = insideEdges[l]! + outside[l]!;
    boundaryShare[l] = all > 0 ? outside[l]! / all : 0;
  }
  return { maskedShare, boundaryShare };
}

export function detectLowVigorZones(input: { values: Float32Array; inside: Uint8Array | null; grid: Grid; params?: Partial<ZoneParams> }): ZonesResult {
  const p: ZoneParams = { ...ZONE_DEFAULTS, ...(input.params ?? {}) };
  const { values, inside, grid } = input;
  if (values.length !== grid.width * grid.height || (inside && inside.length !== values.length)) {
    throw new InvalidInputError("band_shape_mismatch", "Zone detection needs values and AOI mask on the grid.");
  }
  if (!(p.minAreaM2 >= 0) || !(p.k > 0) || !(p.minDeficit >= 0)) throw new InvalidInputError("invalid_parameters", "Zone parameters must be positive.");

  const field = robustFieldStats(values, inside, p);
  if (!field) return { status: "not_applicable", reason: "No usable pixels in this image.", field: null };
  if (field.validFraction < p.minValidFraction) {
    return {
      status: "not_applicable",
      reason: `Only ${Math.round(field.validFraction * 100)}% of the area was usable in this image (zones need ${Math.round(p.minValidFraction * 100)}%); masked gaps would create false edges.`,
      field,
    };
  }
  if (field.validPixels < p.minValidPixels) {
    return { status: "not_applicable", reason: `Only ${field.validPixels} usable pixels (zones need ${p.minValidPixels}).`, field };
  }
  if (field.median < p.minMedianNdvi) {
    return {
      status: "not_applicable",
      reason: `The area's median NDVI is ${field.median.toFixed(2)} (below ${p.minMedianNdvi}): mostly bare soil, before emergence, or after harvest, where relative low zones are not meaningful.`,
      field,
    };
  }

  const low = new Uint8Array(values.length);
  let lowCount = 0;
  for (let i = 0; i < values.length; i++) {
    if (inside && !inside[i]) continue;
    const v = values[i]!;
    if (Number.isFinite(v) && v < field.threshold) {
      low[i] = 1;
      lowCount++;
    }
  }
  const labels = labelComponents(low, grid.width, grid.height);
  const stats = componentStats(labels, grid, values);
  const edge = edgeFractions(labels.labels, labels.count, values, inside, grid.width, grid.height);
  const rowArea = rowAreasM2(grid);
  let validAreaM2 = 0;
  for (let r = 0; r < grid.height; r++) {
    for (let c = 0; c < grid.width; c++) {
      const i = r * grid.width + c;
      if ((!inside || inside[i]) && Number.isFinite(values[i]!)) validAreaM2 += rowArea[r]!;
    }
  }

  const kept = stats
    .filter((s) => s.areaM2 >= p.minAreaM2 && s.meanDelta !== null)
    .map((s) => {
      const meanNdvi = s.meanDelta!;
      const deficit = field.median - meanNdvi;
      return { s, meanNdvi, deficit, score: (s.areaM2 / 10_000) * deficit };
    })
    .sort((a, b) => b.score - a.score || a.s.label - b.s.label);
  const chosen = kept.slice(0, p.maxZones);
  const zones: Zone[] = chosen.map(({ s, meanNdvi, deficit, score }, idx) => {
    const geometry = toLonLatMultiPolygon(vectorizeComponent(labels.labels, grid, s.label, s.bbox), grid.epsg);
    return {
      geometry,
      bbox: lonLatBBox(geometry),
      pixelBBox: s.bbox,
      label: s.label,
      metrics: {
        rank: idx + 1,
        pixel_count: s.pixelCount,
        area_m2: s.areaM2,
        mean_ndvi: meanNdvi,
        min_ndvi: s.minDelta!,
        field_median: field.median,
        deficit,
        relative_deficit: field.median > 0 ? deficit / field.median : 0,
        threshold: field.threshold,
        score,
        edge_masked_fraction: edge.maskedShare[s.label]!,
        boundary_edge_fraction: edge.boundaryShare[s.label]!,
        share_of_valid_area: validAreaM2 > 0 ? s.areaM2 / validAreaM2 : 0,
      },
    };
  });
  return {
    status: "valid",
    field,
    zones,
    omitted: kept.length - chosen.length,
    belowMinArea: stats.length - kept.length,
    lowFraction: field.validPixels ? lowCount / field.validPixels : 0,
    labels,
  };
}

export type Persistence =
  | { state: "persistent"; date: string; lowShare: number; coveredShare: number }
  | { state: "not_persistent"; date: string; lowShare: number; coveredShare: number }
  | { state: "unknown"; reason: string; date?: string };

/**
 * Was the zone also low in an earlier image? `prior` is that image's NDVI on
 * the SAME grid (aligned by the caller) and `priorThreshold` the same rule
 * applied to that image. Persistent when ≥ 50 % of the zone's pixels that
 * have a value in the earlier image were below its threshold; unknown when
 * fewer than half of the zone's pixels have a value there.
 */
export function zonePersistence(labels: Int32Array, label: number, bbox: PixelBBox, width: number, prior: Float32Array, priorThreshold: number, date: string): Persistence {
  let total = 0;
  let covered = 0;
  let low = 0;
  for (let r = bbox.minRow; r <= bbox.maxRow; r++) {
    for (let c = bbox.minCol; c <= bbox.maxCol; c++) {
      const i = r * width + c;
      if (labels[i] !== label) continue;
      total++;
      const v = prior[i]!;
      if (!Number.isFinite(v)) continue;
      covered++;
      if (v < priorThreshold) low++;
    }
  }
  const coveredShare = total ? covered / total : 0;
  if (coveredShare < 0.5) return { state: "unknown", reason: `The earlier image (${date}) had values for only ${Math.round(coveredShare * 100)}% of this zone.`, date };
  const lowShare = low / covered;
  return { state: lowShare >= 0.5 ? "persistent" : "not_persistent", date, lowShare, coveredShare };
}

export type Grade = "strong" | "moderate" | "weak";
const ORDER: Grade[] = ["weak", "moderate", "strong"];
const lower = (a: Grade, b: Grade): Grade => (ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b);

/**
 * Evidence grade for one zone, with the reasons that produced it. Pure; unit-tested.
 * Persistence can lift concerns specific to one image (size noise, masked edges,
 * that image's masking) but not boundary mixing, which is capped last.
 */
export function gradeZone(m: ZoneMetrics, ctx: { maskedFraction: number; persistence: Persistence }): { grade: Grade; reasons: string[] } {
  const reasons: string[] = [];
  let grade: Grade = m.deficit >= 0.2 ? "strong" : m.deficit >= 0.12 ? "moderate" : "weak";
  reasons.push(`Zone mean NDVI ${m.mean_ndvi.toFixed(2)} is ${m.deficit.toFixed(2)} below the area's median of ${m.field_median.toFixed(2)} on this date.`);
  if (m.pixel_count < 30) {
    grade = lower(grade, "weak");
    reasons.push(`Small zone (${m.pixel_count} pixels); a few mixed or misclassified pixels could account for it.`);
  }
  if (m.edge_masked_fraction > 0.3) {
    grade = lower(grade, "weak");
    reasons.push(`${Math.round(m.edge_masked_fraction * 100)}% of the zone's edge borders cloud-, shadow-, or no-data-masked pixels; residual cloud shadow is possible.`);
  }
  if (ctx.maskedFraction > 0.2) {
    grade = lower(grade, "moderate");
    reasons.push(`${Math.round(ctx.maskedFraction * 100)}% of the area was masked in this image.`);
  }
  const ps = ctx.persistence;
  if (ps.state === "persistent") {
    grade = grade === "weak" ? "moderate" : "strong";
    reasons.push(`Also low in the previous usable image (${ps.date}): ${Math.round(ps.lowShare * 100)}% of the zone was below that image's threshold.`);
  } else if (ps.state === "not_persistent") {
    grade = lower(grade, "moderate");
    reasons.push(`Not low in the previous usable image (${ps.date}); it may be short-lived or an artefact of this image.`);
  } else {
    reasons.push(ps.reason);
  }
  // Applied after persistence: a road or margin next to the field is in every image too, so
  // persistence cannot vouch for a zone along the boundary.
  if (m.boundary_edge_fraction > 0.3) {
    grade = lower(grade, "moderate");
    reasons.push(
      `${Math.round(m.boundary_edge_fraction * 100)}% of the zone's edge is the area's boundary; pixels there mix with neighbouring land (roads, margins, other crops), although edge effects such as headland compaction can be real.`,
    );
  }
  return { grade, reasons };
}
