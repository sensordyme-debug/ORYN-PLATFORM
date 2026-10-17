/**
 * Summary statistics over the valid pixels of a Float32 grid.
 *
 * - Only finite values are used (NaN = no value), optionally restricted to an
 *   `include` mask (e.g. inside the AOI).
 * - Percentiles are exact: the valid values are sorted and the percentile is
 *   linearly interpolated between closest ranks — Hyndman & Fan type 7, the
 *   default of NumPy and R: h = (n − 1)·p, q = x[⌊h⌋] + (h − ⌊h⌋)(x[⌊h⌋+1] − x[⌊h⌋]).
 *   The median is the 0.5 percentile (mean of the two middle values for even n).
 * - std is the POPULATION standard deviation, computed in two passes (mean
 *   first) in float64 for numerical stability.
 * - Histograms use fixed ranges; bin i covers [min + i·w, min + (i+1)·w), the
 *   last bin also includes `max`. Values outside the range are not counted.
 */
import type { Histogram } from "./types";

export type SummaryStats = {
  count: number;
  mean: number;
  median: number;
  p10: number;
  p90: number;
  std: number;
  min: number;
  max: number;
};

/** Finite values (where include is 1), sorted ascending. */
export function sortedValid(values: Float32Array, include?: Uint8Array | null): Float32Array {
  let n = 0;
  for (let i = 0; i < values.length; i++) if ((!include || include[i]) && Number.isFinite(values[i]!)) n++;
  const out = new Float32Array(n);
  let k = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if ((!include || include[i]) && Number.isFinite(v)) out[k++] = v;
  }
  return out.sort();
}

/** Type-7 percentile of an ascending array; p in [0, 1]. */
export function percentileOfSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  if (!(p >= 0 && p <= 1)) throw new RangeError(`Percentile must be in [0, 1], got ${p}`);
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  return a + (h - lo) * (b - a);
}

/** Summary of the finite values, or null when there are none. */
export function summarize(values: Float32Array, include?: Uint8Array | null): SummaryStats | null {
  const sorted = sortedValid(values, include);
  const n = sorted.length;
  if (n === 0) return null;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sorted[i]!;
  const mean = sum / n;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const d = sorted[i]! - mean;
    ss += d * d;
  }
  return {
    count: n,
    mean,
    median: percentileOfSorted(sorted, 0.5),
    p10: percentileOfSorted(sorted, 0.1),
    p90: percentileOfSorted(sorted, 0.9),
    std: Math.sqrt(ss / n),
    min: sorted[0]!,
    max: sorted[n - 1]!,
  };
}

/** Mean of the finite values (where include is 1), or null. */
export function meanOf(values: Float32Array, include?: Uint8Array | null): number | null {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if ((!include || include[i]) && Number.isFinite(v)) {
      sum += v;
      n++;
    }
  }
  return n === 0 ? null : sum / n;
}

/** Fixed-range histogram of the finite values. */
export function histogram(values: Float32Array, include: Uint8Array | null | undefined, min: number, max: number, bins: number): Histogram {
  if (!(max > min) || !(bins >= 1) || !Number.isInteger(bins)) throw new RangeError("Histogram needs max > min and an integer bin count ≥ 1.");
  const counts = new Array<number>(bins).fill(0);
  const scale = bins / (max - min);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if ((include && !include[i]) || !(v >= min && v <= max)) continue;
    const b = Math.min(bins - 1, Math.floor((v - min) * scale));
    counts[b] = counts[b]! + 1;
  }
  return { min, max, counts };
}
