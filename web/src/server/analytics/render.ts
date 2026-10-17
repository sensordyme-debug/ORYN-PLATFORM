/**
 * Colour rendering of analysis grids to RGBA PNG, with a matching legend.
 *
 * Conventions shared by every renderer:
 *   outside the AOI                      fully transparent
 *   inside the AOI, no value             MASKED_RGBA — neutral grey at 55 %
 *     (cloud, shadow, snow, no data)     opacity, so excluded pixels are visible
 *   inside the AOI, value                opaque colour from the product palette
 * The legend's final stop is always the masked entry, with
 * value = LEGEND_MASKED_VALUE (−9999, outside every data range) so consumers
 * can tell it apart from gradient stops.
 *
 * Palettes (colours interpolated linearly in sRGB between stops, clamped at
 * the ends):
 *   NDVI     fixed −0.2 … 0.9, brown → yellow → green (NDVI_STOPS)
 *   ΔNDVI    fixed −0.5 … +0.5, red → white → green (DELTA_NDVI_STOPS)
 *   NDWI     fixed −0.6 … +0.6, tan → white → blue, white at the 0 threshold
 *   water    blue = water candidate, pale = not water
 *   landcover provider palette (see landcover.ts)
 *   true colour  8-bit `visual` asset as-is, or reflectance with one joint
 *            2–98 % percentile stretch for all three bands (preserves hue).
 */
import type { RasterRef } from "./types";
import type { BandScaling } from "./indices";
import type { LandcoverTable } from "./landcover";
import { encodePng } from "./png";
import type { TypedArray } from "./raster/resample";
import { percentileOfSorted } from "./stats";

export type Legend = RasterRef["legend"];
export type LegendStop = NonNullable<Legend["stops"]>[number];
export type RenderResult = { png: Buffer; legend: Legend };
type Rgba = [number, number, number, number];

export const MASKED_RGBA: Rgba = [128, 128, 128, 140];
export const LEGEND_MASKED_VALUE = -9999;
export const MASKED_STOP: LegendStop = {
  value: LEGEND_MASKED_VALUE,
  color: "rgba(128, 128, 128, 0.55)",
  label: "Masked: cloud, shadow, snow, or no data",
};

export const NDVI_STOPS: LegendStop[] = [
  { value: -0.2, color: "#8c510a", label: "≤ −0.2" },
  { value: 0, color: "#bf812d" },
  { value: 0.2, color: "#dfc27d" },
  { value: 0.35, color: "#fee08b" },
  { value: 0.5, color: "#d9ef8b" },
  { value: 0.65, color: "#91cf60" },
  { value: 0.8, color: "#1a9850" },
  { value: 0.9, color: "#006837", label: "≥ 0.9" },
];

export const DELTA_NDVI_STOPS: LegendStop[] = [
  { value: -0.5, color: "#a50026", label: "≤ −0.5 (decrease)" },
  { value: -0.25, color: "#f46d43" },
  { value: 0, color: "#f7f7f7", label: "0 (no change)" },
  { value: 0.25, color: "#66bd63" },
  { value: 0.5, color: "#006837", label: "≥ +0.5 (increase)" },
];

/** NDMI: ColorBrewer BrBG (diverging, colour-blind safe) — dry/sparse canopy brown, high canopy water teal. */
export const NDMI_STOPS: LegendStop[] = [
  { value: -0.4, color: "#8c510a", label: "≤ −0.4 (low canopy water)" },
  { value: -0.2, color: "#d8b365" },
  { value: 0, color: "#f6e8c3", label: "0" },
  { value: 0.2, color: "#c7eae5" },
  { value: 0.4, color: "#5ab4ac" },
  { value: 0.6, color: "#01665e", label: "≥ 0.6 (high canopy water)" },
];

export const NDWI_STOPS: LegendStop[] = [
  { value: -0.6, color: "#a6611a", label: "≤ −0.6" },
  { value: -0.3, color: "#dfc27d" },
  { value: 0, color: "#f7f7f7", label: "0 (water threshold)" },
  { value: 0.3, color: "#6baed6" },
  { value: 0.6, color: "#08519c", label: "≥ 0.6" },
];

export const WATER_COLOR = "#1f78b4";
const NOT_WATER_RGBA: Rgba = [240, 234, 214, 110];

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Invalid colour ${hex}`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Precomputed colour ramp: 1024-entry lookup over [first stop, last stop]. */
export function colorRamp(stops: LegendStop[]): (v: number) => Rgba {
  const pts = stops.map((s) => ({ v: s.value, rgb: hexToRgb(s.color) }));
  const lo = pts[0]!.v;
  const hi = pts[pts.length - 1]!.v;
  const N = 1024;
  const lut = new Uint8Array(N * 3);
  for (let k = 0; k < N; k++) {
    const v = lo + ((hi - lo) * k) / (N - 1);
    let j = 0;
    while (j < pts.length - 2 && v > pts[j + 1]!.v) j++;
    const a = pts[j]!;
    const b = pts[j + 1] ?? a;
    const t = b.v === a.v ? 0 : Math.min(1, Math.max(0, (v - a.v) / (b.v - a.v)));
    for (let ch = 0; ch < 3; ch++) lut[k * 3 + ch] = Math.round(a.rgb[ch]! + (b.rgb[ch]! - a.rgb[ch]!) * t);
  }
  return (v: number): Rgba => {
    const k = Math.round(((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (N - 1));
    return [lut[k * 3]!, lut[k * 3 + 1]!, lut[k * 3 + 2]!, 255];
  };
}

function put(rgba: Uint8Array, i: number, c: Rgba): void {
  const o = i * 4;
  rgba[o] = c[0];
  rgba[o + 1] = c[1];
  rgba[o + 2] = c[2];
  rgba[o + 3] = c[3];
}

/** Continuous product (NDVI, NDWI, NDMI, ΔNDVI): NaN inside the AOI renders as masked grey. */
export function renderContinuous(
  values: Float32Array,
  width: number,
  height: number,
  inside: Uint8Array,
  kind: "ndvi" | "ndwi" | "ndmi" | "delta_ndvi",
): RenderResult {
  const stops = kind === "ndvi" ? NDVI_STOPS : kind === "ndwi" ? NDWI_STOPS : kind === "ndmi" ? NDMI_STOPS : DELTA_NDVI_STOPS;
  const ramp = colorRamp(stops);
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    if (!inside[i]) continue;
    const v = values[i]!;
    put(rgba, i, Number.isFinite(v) ? ramp(v) : MASKED_RGBA);
  }
  return {
    png: encodePng(rgba, width, height),
    legend: { kind, min: stops[0]!.value, max: stops[stops.length - 1]!.value, stops: [...stops, MASKED_STOP] },
  };
}

/** Binary water-candidate map. `valid` = pixels with a usable observation. */
export function renderWaterMask(water: Uint8Array, valid: Uint8Array, width: number, height: number, inside: Uint8Array): RenderResult {
  const [r, g, b] = hexToRgb(WATER_COLOR);
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    if (!inside[i]) continue;
    put(rgba, i, !valid[i] ? MASKED_RGBA : water[i] ? [r, g, b, 255] : NOT_WATER_RGBA);
  }
  return {
    png: encodePng(rgba, width, height),
    legend: {
      kind: "water_mask",
      stops: [
        { value: 1, color: WATER_COLOR, label: "Open-water candidate" },
        { value: 0, color: "rgba(240, 234, 214, 0.43)", label: "Not water" },
        MASKED_STOP,
      ],
    },
  };
}

/** Land-cover classes in the provider palette; legend lists the classes present plus the masked entry. */
export function renderLandcover(codes: TypedArray, valid: Uint8Array, width: number, height: number, inside: Uint8Array, table: LandcoverTable): RenderResult {
  const colors = new Map(table.classes.map((c) => [c.code, [...hexToRgb(c.color), 255] as Rgba]));
  const present = new Set<number>();
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    if (!inside[i]) continue;
    const color = valid[i] ? colors.get(codes[i]!) : undefined;
    if (color) present.add(codes[i]!);
    put(rgba, i, color ?? MASKED_RGBA);
  }
  const stops: LegendStop[] = table.classes.filter((c) => present.has(c.code)).map((c) => ({ value: c.code, color: c.color, label: c.label }));
  return {
    png: encodePng(rgba, width, height),
    legend: { kind: "landcover", stops: [...stops, { ...MASKED_STOP, label: "No land-cover information (no data or clouds)" }] },
  };
}

export type TrueColorMode = { mode: "direct8bit" } | { mode: "stretch"; scaling: [BandScaling, BandScaling, BandScaling] };

/** Up to ~1 M reflectance samples (all three bands) from pixels with data, for the stretch. */
function stretchRange(bands: [TypedArray, TypedArray, TypedArray], scaling: [BandScaling, BandScaling, BandScaling], hasData: Uint8Array): [number, number] | null {
  let n = 0;
  for (let i = 0; i < hasData.length; i++) if (hasData[i]) n++;
  if (n === 0) return null;
  const step = Math.max(1, Math.ceil((n * 3) / 1_000_000));
  const sample: number[] = [];
  let k = 0;
  for (let i = 0; i < hasData.length; i++) {
    if (!hasData[i]) continue;
    if (k++ % step !== 0) continue;
    for (let b = 0; b < 3; b++) sample.push(bands[b]![i]! * scaling[b]!.scale + scaling[b]!.offset);
  }
  const sorted = Float64Array.from(sample).sort();
  const lo = percentileOfSorted(sorted, 0.02);
  const hi = percentileOfSorted(sorted, 0.98);
  return hi > lo ? [lo, hi] : [lo, lo + 1e-6];
}

/**
 * True-colour preview. `hasData` = inside the AOI with valid data in all three
 * bands; other AOI pixels render as masked grey. Clouds are NOT greyed out
 * here — a true-colour image should show them.
 */
export function renderTrueColor(
  bands: [TypedArray, TypedArray, TypedArray],
  width: number,
  height: number,
  inside: Uint8Array,
  hasData: Uint8Array,
  mode: TrueColorMode,
): RenderResult {
  const rgba = new Uint8Array(width * height * 4);
  const range = mode.mode === "stretch" ? stretchRange(bands, mode.scaling, hasData) : null;
  for (let i = 0; i < width * height; i++) {
    if (!inside[i]) continue;
    if (!hasData[i]) {
      put(rgba, i, MASKED_RGBA);
      continue;
    }
    const px: Rgba = [0, 0, 0, 255];
    for (let b = 0; b < 3; b++) {
      const dn = bands[b]![i]!;
      if (mode.mode === "direct8bit" || !range) {
        px[b] = Math.max(0, Math.min(255, Math.round(dn)));
      } else {
        const s = mode.scaling[b]!;
        const t = (dn * s.scale + s.offset - range[0]) / (range[1] - range[0]);
        px[b] = Math.round(255 * Math.max(0, Math.min(1, t)));
      }
    }
    put(rgba, i, px);
  }
  const legend: Legend = { kind: "true_color", stops: [{ ...MASKED_STOP, label: "No data" }] };
  if (range) {
    legend.min = range[0];
    legend.max = range[1];
  }
  return { png: encodePng(rgba, width, height), legend };
}
