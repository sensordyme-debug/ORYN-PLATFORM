/**
 * Spectral indices and radar backscatter conversion, per pixel.
 *
 * Optical bands are converted to surface reflectance with the band's
 * published scale and offset before any ratio is taken:
 *   reflectance = DN · scale + offset          (DN == nodata → no value)
 * e.g. Sentinel-2 L2A processing baseline ≥ 04.00: scale 0.0001, offset −0.1;
 * Landsat C2 L2: scale 2.75e-5, offset −0.2. The values always come from the
 * item's raster:bands metadata (RasterBandInfo), never from assumptions.
 *
 *   NDVI = (NIR − Red) / (NIR + Red)
 *   NDWI = (Green − NIR) / (Green + NIR)          (McFeeters 1996)
 *
 * A result is NaN when either band is nodata, the pixel is excluded by the
 * validity mask, NIR + Red (resp. Green + NIR) ≤ 0, or the ratio falls outside
 * [−1, 1] (possible only when an offset makes one reflectance negative).
 * Arithmetic is float64; results are stored as Float32.
 *
 * Sentinel-1: dB = 10 · log10(linear γ⁰); NaN for nodata, non-finite or ≤ 0.
 */
import type { RasterBandInfo } from "@/server/providers/types";
import { InvalidInputError } from "./errors";
import type { TypedArray } from "./raster/resample";

export type BandScaling = { scale: number; offset: number; nodata: number | null };

/** Default open-water thresholds documented in the analytic registry. */
export const NDWI_WATER_THRESHOLD = 0;
export const S1_WATER_THRESHOLD_DB = -18;

/**
 * Scaling for one band from STAC raster:bands metadata. Offset defaults to 0
 * (STAC raster extension default). When `requireScale` is set and the item
 * does not publish a scale, this throws instead of assuming DN = reflectance.
 * Nodata: the item's value when declared (including an explicit null), else
 * the file's GDAL_NODATA.
 */
export function bandScaling(
  band: RasterBandInfo | undefined,
  fileNodata: number | null,
  opts: { requireScale?: boolean; label?: string } = {},
): BandScaling {
  const scale = band?.scale;
  if (scale === undefined && opts.requireScale) {
    throw new InvalidInputError(
      "missing_band_scaling",
      `${opts.label ?? "Band"} has no published scale/offset (raster:bands); reflectance cannot be derived reliably.`,
    );
  }
  const s = scale ?? 1;
  const o = band?.offset ?? 0;
  if (!Number.isFinite(s) || s === 0 || !Number.isFinite(o)) {
    throw new InvalidInputError("invalid_band_scaling", `${opts.label ?? "Band"} has an invalid scale/offset (${s}, ${o}).`);
  }
  const nodata = band && band.nodata !== undefined ? band.nodata : fileNodata;
  return { scale: s, offset: o, nodata: nodata ?? null };
}

/**
 * Surface reflectance below this value is outside L2A/L2 sensor noise. A large
 * share of clear pixels below it means the scale/offset metadata does not
 * match the pixel values (e.g. a BOA offset applied twice).
 */
export const IMPLAUSIBLE_REFLECTANCE_BELOW = -0.02;

/** How many `include` pixels with data have reflectance below IMPLAUSIBLE_REFLECTANCE_BELOW. */
export function implausibleReflectanceCount(dn: TypedArray, s: BandScaling, include: Uint8Array): { checked: number; below: number } {
  let checked = 0;
  let below = 0;
  for (let i = 0; i < dn.length; i++) {
    if (!include[i]) continue;
    const v = dn[i]!;
    if (v === s.nodata || Number.isNaN(v)) continue;
    checked++;
    if (v * s.scale + s.offset < IMPLAUSIBLE_REFLECTANCE_BELOW) below++;
  }
  return { checked, below };
}

/** Reflectance per pixel (Float32, NaN where nodata or not `valid`). */
export function toReflectance(dn: TypedArray, s: BandScaling, valid?: Uint8Array | null): Float32Array {
  const out = new Float32Array(dn.length);
  for (let i = 0; i < dn.length; i++) {
    const v = dn[i]!;
    out[i] = (valid && !valid[i]) || v === s.nodata || Number.isNaN(v) ? Number.NaN : v * s.scale + s.offset;
  }
  return out;
}

/** (A − B) / (A + B) on reflectance; see module doc for the NaN rules. */
export function normalizedDifference(a: TypedArray, sa: BandScaling, b: TypedArray, sb: BandScaling, valid: Uint8Array | null): Float32Array {
  if (a.length !== b.length || (valid && valid.length !== a.length)) {
    throw new InvalidInputError("band_shape_mismatch", "Bands passed to a normalized difference must have the same length.");
  }
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const da = a[i]!;
    const db = b[i]!;
    if ((valid && !valid[i]) || da === sa.nodata || db === sb.nodata) {
      out[i] = Number.NaN;
      continue;
    }
    const ra = da * sa.scale + sa.offset;
    const rb = db * sb.scale + sb.offset;
    const sum = ra + rb;
    const v = (ra - rb) / sum;
    out[i] = sum > 0 && v >= -1 && v <= 1 ? v : Number.NaN;
  }
  return out;
}

/** NDVI = (NIR − Red) / (NIR + Red). */
export function ndvi(nir: TypedArray, nirScaling: BandScaling, red: TypedArray, redScaling: BandScaling, valid: Uint8Array | null): Float32Array {
  return normalizedDifference(nir, nirScaling, red, redScaling, valid);
}

/** NDWI (McFeeters) = (Green − NIR) / (Green + NIR). */
export function ndwi(green: TypedArray, greenScaling: BandScaling, nir: TypedArray, nirScaling: BandScaling, valid: Uint8Array | null): Float32Array {
  return normalizedDifference(green, greenScaling, nir, nirScaling, valid);
}

/** Linear backscatter → dB. NaN where nodata, non-finite, ≤ 0, or not `valid`. */
export function linearToDb(values: TypedArray, nodata: number | null, valid?: Uint8Array | null): Float32Array {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    out[i] = (valid && !valid[i]) || v === nodata || !(v > 0) || !Number.isFinite(v) ? Number.NaN : 10 * Math.log10(v);
  }
  return out;
}

/** 1 where the value is finite and strictly below `threshold` (radar water candidate). */
export function belowThreshold(values: Float32Array, threshold: number): Uint8Array {
  const out = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) if (values[i]! < threshold) out[i] = 1;
  return out;
}

/** 1 where the value is finite and strictly above `threshold` (NDWI water candidate). */
export function aboveThreshold(values: Float32Array, threshold: number): Uint8Array {
  const out = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) if (values[i]! > threshold) out[i] = 1;
  return out;
}
