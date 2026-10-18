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
 *   NDMI = (NIR − SWIR1) / (NIR + SWIR1)          (Gao 1996)
 *   EVI  = G·(NIR − Red) / (NIR + C1·Red − C2·Blue + L)
 *          G = 2.5, C1 = 6, C2 = 7.5, L = 1       (Huete et al. 2002)
 *   SAVI = (1 + L)·(NIR − Red) / (NIR + Red + L),  L = 0.5   (Huete 1988)
 * EVI and SAVI coefficients are the ones USGS uses for its Landsat Level-2
 * surface-reflectance EVI and SAVI products, whose valid output range is
 * −1 to 1 (−10,000 to 10,000 at scale 0.0001). Both formulas assume
 * reflectance in [0, 1]; they are wrong on digital numbers, so they run only
 * after the scale/offset conversion below.
 *
 * A result is NaN when any band is nodata, the pixel is excluded by the
 * validity mask, the denominator is ≤ 0, or the value falls outside [−1, 1]
 * (for the normalized differences, possible only when an offset makes a
 * reflectance negative; for EVI, when a very bright blue band — residual
 * cloud, haze, snow — drives the denominator towards zero). Every
 * computation counts the pixels rejected for each reason.
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

// ── Shared index engine ───────────────────────────────────────

/** Reflectance bands by role (resolved to asset keys per collection in analyze.ts). */
export type BandRole = "blue" | "green" | "red" | "nir" | "nir08" | "swir16";

export type SpectralIndexId = "ndvi" | "ndmi" | "ndwi" | "evi" | "savi";

export const EVI_COEFFICIENTS = Object.freeze({ G: 2.5, C1: 6, C2: 7.5, L: 1 });
export const SAVI_L = 0.5;

export type SpectralIndexDefinition = {
  id: SpectralIndexId;
  formula: string;
  /** Bands in the order `compute` receives their reflectances. */
  bands: readonly BandRole[];
  /** Values outside this closed range are rejected as invalid. */
  validRange: readonly [number, number];
  /** Coefficients, recorded with every result. */
  parameters: Readonly<Record<string, number>>;
  reference: string;
  /** Value from reflectances; NaN when the denominator is ≤ 0. */
  compute: (r: readonly number[]) => number;
};

const nd = (a: number, b: number) => (a + b > 0 ? (a - b) / (a + b) : Number.NaN);

export const SPECTRAL_INDICES: Record<SpectralIndexId, SpectralIndexDefinition> = {
  ndvi: {
    id: "ndvi",
    formula: "(NIR − Red) / (NIR + Red)",
    bands: ["nir", "red"],
    validRange: [-1, 1],
    parameters: {},
    reference: "Rouse et al. (1974); Tucker (1979)",
    compute: ([nir, red]) => nd(nir!, red!),
  },
  ndmi: {
    id: "ndmi",
    formula: "(NIR − SWIR1) / (NIR + SWIR1)",
    bands: ["nir08", "swir16"],
    validRange: [-1, 1],
    parameters: {},
    reference: "Gao (1996), Remote Sensing of Environment 58:257–266",
    compute: ([nir, swir]) => nd(nir!, swir!),
  },
  ndwi: {
    id: "ndwi",
    formula: "(Green − NIR) / (Green + NIR)",
    bands: ["green", "nir"],
    validRange: [-1, 1],
    parameters: {},
    reference: "McFeeters (1996), International Journal of Remote Sensing 17:1425–1432",
    compute: ([green, nir]) => nd(green!, nir!),
  },
  evi: {
    id: "evi",
    formula: "G · (NIR − Red) / (NIR + C1 · Red − C2 · Blue + L)",
    bands: ["nir", "red", "blue"],
    validRange: [-1, 1],
    parameters: EVI_COEFFICIENTS,
    reference: "Huete et al. (2002), Remote Sensing of Environment 83:195–213; coefficients as in the USGS Landsat Level-2 EVI product",
    compute: ([nir, red, blue]) => {
      const { G, C1, C2, L } = EVI_COEFFICIENTS;
      const den = nir! + C1 * red! - C2 * blue! + L;
      return den > 0 ? (G * (nir! - red!)) / den : Number.NaN;
    },
  },
  savi: {
    id: "savi",
    formula: "(1 + L) · (NIR − Red) / (NIR + Red + L)",
    bands: ["nir", "red"],
    validRange: [-1, 1],
    parameters: { L: SAVI_L },
    reference: "Huete (1988), Remote Sensing of Environment 25:295–309; L = 0.5 as in the USGS Landsat Level-2 SAVI product",
    compute: ([nir, red]) => {
      const den = nir! + red! + SAVI_L;
      return den > 0 ? ((1 + SAVI_L) * (nir! - red!)) / den : Number.NaN;
    },
  },
};

export type IndexRejections = { invalid_denominator: number; out_of_range: number };
export type BandInput = { values: TypedArray; scaling: BandScaling };

/**
 * One spectral index per pixel from reflectance. NaN where `valid` excludes
 * the pixel, any band is nodata, the denominator is ≤ 0, or the value is
 * outside the index's valid range; the last two are counted separately (only
 * for pixels that passed `valid` and have data in every band).
 */
export function computeIndex(def: SpectralIndexDefinition, inputs: readonly BandInput[], valid: Uint8Array | null): { values: Float32Array; rejected: IndexRejections } {
  if (inputs.length !== def.bands.length) {
    throw new InvalidInputError("band_count_mismatch", `${def.id.toUpperCase()} needs ${def.bands.length} bands (${def.bands.join(", ")}); ${inputs.length} were given.`);
  }
  const n = inputs[0]?.values.length ?? 0;
  if (inputs.some((b) => b.values.length !== n) || (valid && valid.length !== n)) {
    throw new InvalidInputError("band_shape_mismatch", "Bands passed to an index must have the same length.");
  }
  const out = new Float32Array(n);
  const rejected: IndexRejections = { invalid_denominator: 0, out_of_range: 0 };
  const r = new Array<number>(inputs.length);
  const [lo, hi] = def.validRange;
  for (let i = 0; i < n; i++) {
    if (valid && !valid[i]) {
      out[i] = Number.NaN;
      continue;
    }
    let missing = false;
    for (let k = 0; k < inputs.length; k++) {
      const b = inputs[k]!;
      const dn = b.values[i]!;
      if (dn === b.scaling.nodata || Number.isNaN(dn)) {
        missing = true;
        break;
      }
      r[k] = dn * b.scaling.scale + b.scaling.offset;
    }
    if (missing) {
      out[i] = Number.NaN;
      continue;
    }
    const v = def.compute(r);
    if (Number.isNaN(v)) {
      rejected.invalid_denominator++;
      out[i] = Number.NaN;
    } else if (v < lo || v > hi) {
      rejected.out_of_range++;
      out[i] = Number.NaN;
    } else out[i] = v;
  }
  return { values: out, rejected };
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
