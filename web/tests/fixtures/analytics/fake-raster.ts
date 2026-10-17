/**
 * In-memory RasterSource for analytics tests: a georeferenced stack of
 * row-major sample arrays (plus optional overview levels), and an opener that
 * maps asset URLs to such rasters.
 */
import type { AssetAccess } from "@/server/providers/types";
import type { RasterOpener } from "@/server/analytics/raster/cog";
import type { RasterInfo, RasterLevel, RasterSource, TypedArray } from "@/server/analytics/raster/resample";

export type MemoryLevel = RasterLevel & { samples: TypedArray[] };

export type MemoryRaster = RasterSource & { windowsRead: [number, number, number, number][] };

export function memoryRaster(opts: {
  epsg: number;
  originX: number;
  originY: number;
  pixelW: number;
  pixelH?: number;
  width: number;
  height: number;
  samples: TypedArray[];
  nodata?: number | null;
  dataType?: string;
  overviews?: MemoryLevel[];
}): MemoryRaster {
  const full: MemoryLevel = {
    width: opts.width,
    height: opts.height,
    pixelW: opts.pixelW,
    pixelH: opts.pixelH ?? opts.pixelW,
    samples: opts.samples,
  };
  for (const s of opts.samples) if (s.length !== opts.width * opts.height) throw new Error("sample length mismatch");
  const levels = [full, ...(opts.overviews ?? [])];
  const first = opts.samples[0]!;
  const info: RasterInfo = {
    epsg: opts.epsg,
    originX: opts.originX,
    originY: opts.originY,
    levels: levels.map(({ width, height, pixelW, pixelH }) => ({ width, height, pixelW, pixelH })),
    samplesPerPixel: opts.samples.length,
    nodata: opts.nodata ?? null,
    dataType: opts.dataType ?? dataTypeOf(first),
  };
  const windowsRead: [number, number, number, number][] = [];
  return {
    info,
    windowsRead,
    async readWindow(level, window, samples, signal) {
      signal?.throwIfAborted();
      const lvl = levels[level]!;
      const [x0, y0, x1, y1] = window;
      if (x0 < 0 || y0 < 0 || x1 > lvl.width || y1 > lvl.height || x1 <= x0 || y1 <= y0) throw new Error(`bad window ${window.join(",")}`);
      windowsRead.push(window);
      const w = x1 - x0;
      return samples.map((s) => {
        const src = lvl.samples[s]!;
        const out = new (src.constructor as new (n: number) => TypedArray)(w * (y1 - y0));
        for (let r = y0; r < y1; r++) for (let c = x0; c < x1; c++) out[(r - y0) * w + (c - x0)] = src[r * lvl.width + c]!;
        return out;
      });
    },
  };
}

function dataTypeOf(a: TypedArray): string {
  if (a instanceof Uint8Array) return "uint8";
  if (a instanceof Uint16Array) return "uint16";
  if (a instanceof Int16Array) return "int16";
  if (a instanceof Float32Array) return "float32";
  if (a instanceof Float64Array) return "float64";
  return "uint32";
}

/** Opener resolving `mem://<key>` URLs to rasters; records every URL opened. */
export function memoryOpener(rasters: Record<string, RasterSource>): RasterOpener & { opened: string[] } {
  const opened: string[] = [];
  const fn = async (access: AssetAccess, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    opened.push(access.url);
    const key = access.url.replace(/^mem:\/\//, "");
    const r = rasters[key];
    if (!r) throw new Error(`no raster for ${access.url}`);
    return r;
  };
  return Object.assign(fn, { opened });
}

export const memResolve = async (key: string): Promise<AssetAccess> => ({ url: `mem://${key}` });

/** Fill a w×h array with f(col, row). */
export function fill<T extends TypedArray>(arr: T, w: number, f: (c: number, r: number) => number): T {
  for (let i = 0; i < arr.length; i++) arr[i] = f(i % w, Math.floor(i / w));
  return arr;
}
