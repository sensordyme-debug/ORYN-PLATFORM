/**
 * Cloud-Optimized GeoTIFF access over HTTP range requests (geotiff.js).
 *
 * - Opens a COG from an AssetAccess (URL + optional headers) and keeps the
 *   parsed header in a small LRU cache (16 files, 10-minute TTL) so the bands
 *   of one scene are not re-parsed for every analytic. The cache key includes
 *   the full URL, so a re-signed URL is a separate entry.
 * - Reads the CRS from the GeoKeys (ProjectedCSTypeGeoKey or
 *   GeographicTypeGeoKey). User-defined or unsupported CRSs, rotated/sheared
 *   transforms, and files without georeferencing are rejected with
 *   InvalidRasterError / UnsupportedCrsError instead of being guessed.
 *   PixelIsPoint rasters are shifted half a pixel to area convention, as GDAL does.
 * - Every HTTP request has a 60 s timeout. Transport failures and HTTP errors
 *   become AssetReadError (retryable except 400/404/410/416…); undecodable
 *   files become InvalidRasterError (permanent). Caller aborts propagate the
 *   signal's reason unchanged.
 * - Overviews (reduced-resolution IFDs) are used only when the caller passes
 *   allowOverviews; transparency-mask IFDs are ignored.
 */
import { BaseClient, BaseResponse, fromCustomClient, type GeoTIFFImage } from "geotiff";
import type { AssetAccess } from "@/server/providers/types";
import { AssetReadError, InvalidRasterError, RasterAnalyticsError, UnsupportedCrsError, redactUrl } from "../errors";
import type { Grid } from "./grid";
import { isSupportedEpsg } from "./projection";
import { readSourceToGrid, type GridRead, type RasterInfo, type RasterLevel, type RasterSource, type ReadToGridOptions, type TypedArray } from "./resample";

const DEFAULT_TIMEOUT_MS = 60_000;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 16;

/** TIFF NewSubfileType bits. */
const SUBFILE_REDUCED = 1;
const SUBFILE_MASK = 4;

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/** fetch() response adapted to geotiff's BaseResponse; body-read failures become AssetReadError. */
class GuardedResponse extends BaseResponse {
  constructor(
    private readonly res: Response,
    private readonly url: string,
    private readonly caller: AbortSignal | undefined,
  ) {
    super();
  }
  override get status(): number {
    return this.res.status;
  }
  override getHeader(name: string): string | undefined {
    return this.res.headers.get(name) ?? undefined;
  }
  override async getData(): Promise<ArrayBuffer> {
    try {
      return await this.res.arrayBuffer();
    } catch (err) {
      if (this.caller?.aborted) throw this.caller.reason;
      throw new AssetReadError(`Reading ${redactUrl(this.url)} was interrupted: ${(err as Error).message}`, { url: redactUrl(this.url), cause: err });
    }
  }
}

/** geotiff HTTP client with a per-request timeout and typed transport errors. */
class GuardedClient extends BaseClient {
  constructor(
    url: string,
    private readonly timeoutMs: number,
  ) {
    super(url);
  }

  override async request(options: RequestInit = {}): Promise<BaseResponse> {
    const caller = options.signal ?? undefined;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
    const shown = redactUrl(this.url);
    let res: Response;
    try {
      res = await fetch(this.url, { headers: options.headers, signal });
    } catch (err) {
      if (caller?.aborted) throw caller.reason;
      const why = timeout.aborted ? `timed out after ${Math.round(this.timeoutMs / 1000)} s` : (err as Error).message;
      throw new AssetReadError(`Request for ${shown} failed: ${why}`, { url: shown, cause: err });
    }
    if (res.status !== 200 && res.status !== 206) {
      await res.body?.cancel().catch(() => undefined);
      throw new AssetReadError(`Request for ${shown} failed with HTTP ${res.status}.`, { status: res.status, url: shown });
    }
    return new GuardedResponse(res, this.url, caller);
  }
}

/** Map a geotiff failure onto the engine's error taxonomy. */
function classify(err: unknown, signal: AbortSignal | undefined, label: string): unknown {
  if (signal?.aborted) return signal.reason;
  if (err instanceof RasterAnalyticsError || isAbortError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/full file/i.test(message)) {
    return new AssetReadError(`${label}: the server does not support HTTP range requests.`, { retryable: false, cause: err });
  }
  return new InvalidRasterError(`${label}: could not decode GeoTIFF (${message}).`, { cause: err });
}

function dataTypeOf(image: GeoTIFFImage): string {
  const format = image.getSampleFormat(0);
  const bits = image.getBitsPerSample(0);
  const kind = format === 3 ? "float" : format === 2 ? "int" : "uint";
  return `${kind}${bits}`;
}

/** Georeferencing of the full-resolution image. Throws rather than guessing. */
function describe(first: GeoTIFFImage, label: string): Omit<RasterInfo, "levels"> & { full: RasterLevel } {
  const keys = first.getGeoKeys() as Record<string, unknown> | null;
  if (!keys) throw new InvalidRasterError(`${label} has no GeoTIFF keys (not georeferenced).`);
  const model = keys.GTModelTypeGeoKey;
  const code = model === 2 ? keys.GeographicTypeGeoKey : (keys.ProjectedCSTypeGeoKey ?? keys.GeographicTypeGeoKey);
  if (typeof code !== "number" || code === 32767) {
    throw new UnsupportedCrsError(typeof code === "number" ? code : null, `${label} does not declare an EPSG code`);
  }
  if (!isSupportedEpsg(code)) throw new UnsupportedCrsError(code, label);

  const fd = first.fileDirectory;
  const mt = fd.getValue("ModelTransformation") as number[] | undefined;
  let originX: number;
  let originY: number;
  let pw: number;
  let ph: number;
  if (mt && mt.length >= 8) {
    if (mt[1] !== 0 || mt[4] !== 0) throw new InvalidRasterError(`${label} has a rotated or sheared transform, which is not supported.`);
    originX = mt[3]!;
    originY = mt[7]!;
    pw = mt[0]!;
    ph = -mt[5]!;
  } else {
    const tie = fd.getValue("ModelTiepoint") as number[] | undefined;
    const scale = fd.getValue("ModelPixelScale") as number[] | undefined;
    if (!tie || tie.length < 6 || !scale || scale.length < 2) throw new InvalidRasterError(`${label} has no affine georeferencing.`);
    pw = scale[0]!;
    ph = scale[1]!;
    originX = tie[3]! - tie[0]! * pw;
    originY = tie[4]! + tie[1]! * ph;
  }
  if (!(pw > 0) || !(ph > 0) || ![originX, originY, pw, ph].every(Number.isFinite)) {
    throw new InvalidRasterError(`${label} is not a north-up raster with positive pixel size.`);
  }
  if (keys.GTRasterTypeGeoKey === 2) {
    // PixelIsPoint: tie point refers to the pixel centre.
    originX -= pw / 2;
    originY += ph / 2;
  }
  return {
    epsg: code,
    originX,
    originY,
    samplesPerPixel: first.getSamplesPerPixel(),
    nodata: first.getGDALNoData(),
    dataType: dataTypeOf(first),
    full: { width: first.getWidth(), height: first.getHeight(), pixelW: pw, pixelH: ph },
  };
}

class GeoTiffRaster implements RasterSource {
  constructor(
    readonly info: RasterInfo,
    private readonly images: GeoTIFFImage[],
    private readonly label: string,
  ) {}

  async readWindow(level: number, window: [number, number, number, number], samples: number[], signal?: AbortSignal): Promise<TypedArray[]> {
    const image = this.images[level];
    if (!image) throw new InvalidRasterError(`${this.label} has no resolution level ${level}.`);
    try {
      const result = await image.readRasters({ window, samples, interleave: false, signal });
      return Array.from(result as TypedArray[]);
    } catch (err) {
      throw classify(err, signal, this.label);
    }
  }
}

async function openGeoTiff(access: AssetAccess, timeoutMs: number): Promise<GeoTiffRaster> {
  const label = `Asset ${redactUrl(access.url)}`;
  try {
    const tiff = await fromCustomClient(new GuardedClient(access.url, timeoutMs), { headers: access.headers ?? {} });
    const count = await tiff.getImageCount();
    const first = await tiff.getImage(0);
    const { full, ...base } = describe(first, label);
    const levels: RasterLevel[] = [full];
    const images: GeoTIFFImage[] = [first];
    for (let i = 1; i < count; i++) {
      const im = await tiff.getImage(i);
      const subfile = Number(im.fileDirectory.getValue("NewSubfileType") ?? 0);
      if (subfile & SUBFILE_MASK || !(subfile & SUBFILE_REDUCED)) continue;
      if (im.getSamplesPerPixel() !== base.samplesPerPixel) continue;
      const w = im.getWidth();
      const h = im.getHeight();
      if (!(w > 0 && h > 0)) continue;
      levels.push({ width: w, height: h, pixelW: (full.width * full.pixelW) / w, pixelH: (full.height * full.pixelH) / h });
      images.push(im);
    }
    // Finest first, so chooseLevel can take the last acceptable level.
    const order = levels.map((_, i) => i).sort((a, b) => levels[a]!.pixelW - levels[b]!.pixelW);
    return new GeoTiffRaster(
      { ...base, levels: order.map((i) => levels[i]!) },
      order.map((i) => images[i]!),
      label,
    );
  } catch (err) {
    throw classify(err, undefined, label);
  }
}

type CacheEntry = { promise: Promise<GeoTiffRaster>; expiresAt: number };
const cache = new Map<string, CacheEntry>();

function cacheKey(access: AssetAccess): string {
  const headers = access.headers ? Object.entries(access.headers).sort(([a], [b]) => a.localeCompare(b)) : [];
  return `${access.url}\n${JSON.stringify(headers)}`;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Open (or reuse) a COG. The header is parsed once and shared between callers;
 * an aborted caller stops waiting without cancelling other callers' opens.
 */
export async function openCog(access: AssetAccess, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<RasterSource> {
  opts.signal?.throwIfAborted();
  const key = cacheKey(access);
  const now = Date.now();
  let entry = cache.get(key);
  if (entry && entry.expiresAt <= now) {
    cache.delete(key);
    entry = undefined;
  }
  if (entry) {
    // LRU: move to the most-recent end.
    cache.delete(key);
    cache.set(key, entry);
  } else {
    const created: CacheEntry = { promise: openGeoTiff(access, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS), expiresAt: now + CACHE_TTL_MS };
    created.promise.catch(() => {
      if (cache.get(key) === created) cache.delete(key);
    });
    cache.set(key, created);
    while (cache.size > CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
    entry = created;
  }
  return raceAbort(entry.promise, opts.signal);
}

/** Drop all cached COG headers (tests, credential rotation). */
export function clearCogCache(): void {
  cache.clear();
}

/** Open `access` and read it onto `grid` (nearest neighbour; see resample.ts). */
export async function readToGrid(access: AssetAccess, grid: Grid, opts: ReadToGridOptions = {}): Promise<GridRead> {
  const source = await openCog(access, { signal: opts.signal });
  return readSourceToGrid(source, grid, { ...opts, what: opts.what ?? `Asset ${redactUrl(access.url)}` });
}

/** Default way analytics open rasters; analyze.ts accepts a replacement for tests. */
export type RasterOpener = (access: AssetAccess, signal?: AbortSignal) => Promise<RasterSource>;
export const cogOpener: RasterOpener = (access, signal) => openCog(access, { signal });
