/**
 * Reading a georeferenced raster onto an analysis grid.
 *
 * `RasterSource` is the minimal abstraction the engine needs from a raster —
 * georeferencing plus a windowed read — so the COG reader (cog.ts) and
 * in-memory test rasters are interchangeable.
 *
 * readSourceToGrid computes the single source window that covers the target
 * grid, reads it once, and assigns each target pixel the source pixel that
 * contains the target pixel's centre (nearest neighbour). On a shared lattice
 * this is the identity; for a coarser band (20 m SCL onto a 10 m grid) each
 * source pixel fills the target pixels whose centres it contains. Values are
 * never interpolated, so class codes and nodata survive intact.
 *
 * Target pixels whose centre falls outside the source image are reported in
 * `footprint` (0) and filled with the nodata value (or 0 / NaN when the source
 * declares none) — callers must consult `footprint`, not the fill value.
 */
import { CrsMismatchError, InvalidRasterError } from "../errors";
import { DEFAULT_MAX_PIXELS, assertPixelBudget, pixelSizeOf, type Grid } from "./grid";

export type TypedArray = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array;

/** One resolution level of a raster; overviews share the full-resolution origin. */
export type RasterLevel = { width: number; height: number; pixelW: number; pixelH: number };

export type RasterInfo = {
  epsg: number;
  /** Outer top-left corner of pixel (0, 0) in the CRS. */
  originX: number;
  originY: number;
  /** levels[0] is full resolution; further entries are overviews, finest first. */
  levels: RasterLevel[];
  samplesPerPixel: number;
  /** GDAL_NODATA declared by the file, if any. */
  nodata: number | null;
  /** e.g. "uint8", "uint16", "int16", "float32". */
  dataType: string;
};

export interface RasterSource {
  readonly info: RasterInfo;
  /**
   * Read a pixel window [x0, y0, x1, y1) of `level` (x1, y1 exclusive) for the
   * given 0-based samples. Returns one row-major array per sample.
   */
  readWindow(level: number, window: [number, number, number, number], samples: number[], signal?: AbortSignal): Promise<TypedArray[]>;
}

export type GridRead = {
  /** First requested sample, length grid.width × grid.height. */
  values: TypedArray;
  /** All requested samples, in request order. */
  bands: TypedArray[];
  nodata: number | null;
  /** 1 where the target pixel centre lies inside the source image extent. */
  footprint: Uint8Array;
  /** Resolution level that was read (0 = full resolution). */
  level: number;
  /** True when an overview (reduced-resolution level) was used. */
  downsampled: boolean;
};

export type ReadToGridOptions = {
  /** Allow reading a coarser overview (previews only; never for analysis). Default false. */
  allowOverviews?: boolean;
  signal?: AbortSignal;
  /** Samples (bands within the file) to read, default [0]. */
  samples?: number[];
  maxPixels?: number;
  /** Human label used in error messages, e.g. "Band red". */
  what?: string;
};

type TypedArrayCtor = new (length: number) => TypedArray;

const CTORS: Record<string, TypedArrayCtor> = {
  uint8: Uint8Array,
  int8: Int8Array,
  uint16: Uint16Array,
  int16: Int16Array,
  uint32: Uint32Array,
  int32: Int32Array,
  float32: Float32Array,
  float64: Float64Array,
};

/**
 * Coarsest level whose pixel size is ≤ the target pixel size (within 0.5 %,
 * absorbing overview sizes like 79.97 m for a nominal 80 m). Full resolution
 * unless `allowOverviews`.
 */
export function chooseLevel(info: RasterInfo, grid: Grid, allowOverviews: boolean): number {
  if (!allowOverviews) return 0;
  const { pw, ph } = pixelSizeOf(grid);
  const target = Math.min(pw, ph) * 1.005;
  let best = 0;
  info.levels.forEach((lvl, i) => {
    if (Math.max(lvl.pixelW, lvl.pixelH) <= target) best = i;
  });
  return best;
}

/** Source index containing each target pixel centre along one axis, or −1 when outside the source. */
function axisMap(n: number, start: number, step: number, srcOrigin: number, srcStep: number, srcCount: number): Int32Array {
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const centre = start + (i + 0.5) * step;
    const s = Math.floor((centre - srcOrigin) / srcStep);
    out[i] = s >= 0 && s < srcCount ? s : -1;
  }
  return out;
}

/** [min, max] of the non-negative entries, or [Infinity, -Infinity] when there are none. */
function validRange(map: Int32Array): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of map) {
    if (s < 0) continue;
    if (s < lo) lo = s;
    if (s > hi) hi = s;
  }
  return [lo, hi];
}

function fillValueFor(arr: TypedArray, nodata: number | null): number {
  if (nodata !== null && Number.isFinite(nodata)) return nodata;
  return arr instanceof Float32Array || arr instanceof Float64Array ? Number.NaN : 0;
}

/** Read `source` onto `grid` (nearest neighbour on pixel centres). The grid must be in the source's CRS. */
export async function readSourceToGrid(source: RasterSource, grid: Grid, opts: ReadToGridOptions = {}): Promise<GridRead> {
  const info = source.info;
  const what = opts.what ?? "Raster";
  if (info.epsg !== grid.epsg) throw new CrsMismatchError(grid.epsg, info.epsg, what);
  assertPixelBudget(grid.width, grid.height, opts.maxPixels ?? DEFAULT_MAX_PIXELS);
  const samples = opts.samples ?? [0];
  for (const s of samples) {
    if (!Number.isInteger(s) || s < 0 || s >= info.samplesPerPixel) {
      throw new InvalidRasterError(`${what} has ${info.samplesPerPixel} sample(s); sample ${s} was requested.`);
    }
  }
  opts.signal?.throwIfAborted();

  const level = chooseLevel(info, grid, opts.allowOverviews ?? false);
  const lvl = info.levels[level];
  if (!lvl) throw new InvalidRasterError(`${what} has no resolution level ${level}.`);
  const { pw, ph } = pixelSizeOf(grid);
  const cols = axisMap(grid.width, grid.transform[0], pw, info.originX, lvl.pixelW, lvl.width);
  // Rows run southwards: measure distance down from the top edge.
  const rows = axisMap(grid.height, info.originY - grid.transform[3], ph, 0, lvl.pixelH, lvl.height);

  const [x0, x1] = validRange(cols);
  const [y0, y1] = validRange(rows);

  const n = grid.width * grid.height;
  const footprint = new Uint8Array(n);
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) {
    // The grid lies entirely outside the image: nothing to read.
    const empty = samples.map(() => {
      const a = new (CTORS[info.dataType] ?? Float32Array)(n);
      a.fill(fillValueFor(a, info.nodata));
      return a;
    });
    return { values: empty[0]!, bands: empty, nodata: info.nodata, footprint, level, downsampled: level > 0 };
  }

  const ww = x1 - x0 + 1;
  const wh = y1 - y0 + 1;
  const windowData = await source.readWindow(level, [x0, y0, x1 + 1, y1 + 1], samples, opts.signal);
  opts.signal?.throwIfAborted();
  if (windowData.length !== samples.length || windowData.some((a) => a.length !== ww * wh)) {
    throw new InvalidRasterError(`${what}: window read returned an unexpected number of values.`);
  }

  const bands = windowData.map((src) => {
    const out = new (src.constructor as TypedArrayCtor)(n);
    const fill = fillValueFor(out, info.nodata);
    if (fill !== 0) out.fill(fill);
    for (let r = 0; r < grid.height; r++) {
      const sy = rows[r]!;
      if (sy < 0) continue;
      const srcRow = (sy - y0) * ww - x0;
      const dstRow = r * grid.width;
      for (let c = 0; c < grid.width; c++) {
        const sx = cols[c]!;
        if (sx >= 0) out[dstRow + c] = src[srcRow + sx]!;
      }
    }
    return out;
  });
  for (let r = 0; r < grid.height; r++) {
    if (rows[r]! < 0) continue;
    const dstRow = r * grid.width;
    for (let c = 0; c < grid.width; c++) if (cols[c]! >= 0) footprint[dstRow + c] = 1;
  }
  return { values: bands[0]!, bands, nodata: info.nodata, footprint, level, downsampled: level > 0 };
}
