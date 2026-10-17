/**
 * Per-pixel validity masks from provider quality layers.
 *
 * Sentinel-2 L2A Scene Classification Layer (SCL) classes:
 *   0 no data · 1 saturated/defective · 2 dark area pixels / topographic shadow ·
 *   3 cloud shadow · 4 vegetation · 5 not vegetated · 6 water · 7 unclassified ·
 *   8 cloud (medium probability) · 9 cloud (high probability) · 10 thin cirrus ·
 *   11 snow/ice
 *   Valid by default: {4, 5, 6}. Class 7 can be admitted with includeUnclassified.
 *
 * Landsat Collection 2 QA_PIXEL bits:
 *   0 fill · 1 dilated cloud · 2 cirrus · 3 cloud · 4 cloud shadow · 5 snow ·
 *   6 clear · 7 water
 *   Valid when none of bits 0–5 is set.
 *
 * Sentinel-1 RTC: valid when the value is finite, not the nodata value, and > 0
 * (dB is undefined for non-positive backscatter).
 *
 * Every function counts only pixels where `inside` is 1 (when given) and
 * returns 0 in `valid` outside it. `reasons` assigns each masked pixel to
 * exactly one reason (the first matching in the documented priority), so
 * the reason counts sum to `maskedCount`.
 */
import type { TypedArray } from "./resample";

export type MaskResult = {
  /** 1 = usable for analysis. */
  valid: Uint8Array;
  validCount: number;
  maskedCount: number;
  /** Masked pixels by reason (each masked pixel counted once). */
  reasons: Record<string, number>;
};

export const SCL_CLASSES: Record<number, string> = {
  0: "no_data",
  1: "saturated_defective",
  2: "dark_area_topographic_shadow",
  3: "cloud_shadow",
  4: "vegetation",
  5: "not_vegetated",
  6: "water",
  7: "unclassified",
  8: "cloud_medium_probability",
  9: "cloud_high_probability",
  10: "thin_cirrus",
  11: "snow_ice",
};

export const SCL_DEFAULT_VALID = [4, 5, 6] as const;

/**
 * Sentinel-2 SCL mask. `footprint` (optional) marks pixels the SCL raster
 * actually covers; uncovered pixels are masked as "no_data".
 */
export function sclValidMask(
  scl: TypedArray,
  opts: { inside?: Uint8Array | null; footprint?: Uint8Array | null; includeUnclassified?: boolean } = {},
): MaskResult {
  const validClass = new Uint8Array(256);
  for (const c of SCL_DEFAULT_VALID) validClass[c] = 1;
  if (opts.includeUnclassified) validClass[7] = 1;
  const classCounts = new Float64Array(256);
  const valid = new Uint8Array(scl.length);
  const { inside, footprint } = opts;
  let validCount = 0;
  let outOfFootprint = 0;
  let unknown = 0;
  for (let i = 0; i < scl.length; i++) {
    if (inside && !inside[i]) continue;
    if (footprint && !footprint[i]) {
      outOfFootprint++;
      continue;
    }
    const v = scl[i]!;
    if (!(v >= 0 && v <= 255 && Number.isInteger(v))) {
      unknown++;
      continue;
    }
    if (validClass[v]) {
      valid[i] = 1;
      validCount++;
    } else classCounts[v] = classCounts[v]! + 1;
  }
  const reasons: Record<string, number> = {};
  for (let c = 0; c < 256; c++) {
    const n = classCounts[c]!;
    if (n === 0) continue;
    const name = SCL_CLASSES[c] ?? "unknown_class";
    reasons[name] = (reasons[name] ?? 0) + n;
  }
  if (outOfFootprint) reasons.no_data = (reasons.no_data ?? 0) + outOfFootprint;
  if (unknown) reasons.unknown_class = (reasons.unknown_class ?? 0) + unknown;
  const total = inside ? countOnes(inside) : scl.length;
  return { valid, validCount, maskedCount: total - validCount, reasons };
}

/** QA_PIXEL bits that exclude a pixel, in reason priority order. */
const QA_REASONS: [bit: number, reason: string][] = [
  [0, "fill"],
  [3, "cloud"],
  [1, "dilated_cloud"],
  [2, "cirrus"],
  [4, "cloud_shadow"],
  [5, "snow"],
];
const QA_EXCLUDE = QA_REASONS.reduce((m, [bit]) => m | (1 << bit), 0);

/** Landsat Collection 2 QA_PIXEL mask (excludes fill, dilated cloud, cirrus, cloud, cloud shadow, snow). */
export function landsatQaValidMask(qa: TypedArray, opts: { inside?: Uint8Array | null; footprint?: Uint8Array | null } = {}): MaskResult {
  const valid = new Uint8Array(qa.length);
  const reasons: Record<string, number> = {};
  const { inside, footprint } = opts;
  let validCount = 0;
  for (let i = 0; i < qa.length; i++) {
    if (inside && !inside[i]) continue;
    if (footprint && !footprint[i]) {
      reasons.fill = (reasons.fill ?? 0) + 1;
      continue;
    }
    const v = qa[i]!;
    if ((v & QA_EXCLUDE) === 0) {
      valid[i] = 1;
      validCount++;
      continue;
    }
    for (const [bit, reason] of QA_REASONS) {
      if (v & (1 << bit)) {
        reasons[reason] = (reasons[reason] ?? 0) + 1;
        break;
      }
    }
  }
  const total = inside ? countOnes(inside) : qa.length;
  return { valid, validCount, maskedCount: total - validCount, reasons };
}

/** Sentinel-1 backscatter mask: finite, ≠ nodata, > 0. */
export function s1ValidMask(
  values: TypedArray,
  nodata: number | null,
  opts: { inside?: Uint8Array | null; footprint?: Uint8Array | null } = {},
): MaskResult {
  const valid = new Uint8Array(values.length);
  const { inside, footprint } = opts;
  let validCount = 0;
  let noData = 0;
  let nonPositive = 0;
  for (let i = 0; i < values.length; i++) {
    if (inside && !inside[i]) continue;
    const v = values[i]!;
    if ((footprint && !footprint[i]) || !Number.isFinite(v) || (nodata !== null && v === nodata)) {
      noData++;
      continue;
    }
    if (v <= 0) {
      nonPositive++;
      continue;
    }
    valid[i] = 1;
    validCount++;
  }
  const reasons: Record<string, number> = {};
  if (noData) reasons.no_data = noData;
  if (nonPositive) reasons.non_positive_backscatter = nonPositive;
  return { valid, validCount, maskedCount: noData + nonPositive, reasons };
}

/** 1 where `values` holds data (inside footprint, finite, ≠ nodata), restricted to `inside` when given. */
export function dataMask(values: TypedArray, nodata: number | null, footprint?: Uint8Array | null, inside?: Uint8Array | null): Uint8Array {
  const out = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    if (inside && !inside[i]) continue;
    if (footprint && !footprint[i]) continue;
    const v = values[i]!;
    if (Number.isNaN(v) || (nodata !== null && v === nodata)) continue;
    out[i] = 1;
  }
  return out;
}

/** Element-wise AND of masks of equal length. */
export function andMasks(...masks: Uint8Array[]): Uint8Array {
  const first = masks[0];
  if (!first) return new Uint8Array(0);
  const out = Uint8Array.from(first);
  for (const m of masks.slice(1)) for (let i = 0; i < out.length; i++) out[i] = out[i]! & m[i]!;
  return out;
}

export function countOnes(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
}
