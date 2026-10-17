/**
 * Typed errors raised by the raster analytics engine.
 *
 * Every error carries a stable `code` and a `retryable` flag so the processing
 * pipeline can decide between "try again later" (network failures, throttling,
 * expired signatures) and "this input can never succeed" (unsupported CRS,
 * corrupt file, AOI too large). Messages never contain signed-URL query
 * strings; asset URLs are reduced to scheme + host + path before they are
 * embedded.
 *
 * Aborts are NOT wrapped: when the caller's AbortSignal fires, the signal's
 * own reason (normally a DOMException named "AbortError") propagates as-is.
 */

export type RasterErrorCode =
  | "asset_read_failed"
  | "invalid_raster"
  | "unsupported_crs"
  | "crs_mismatch"
  | "raster_too_large"
  | "grid_mismatch"
  | "invalid_input";

export class RasterAnalyticsError extends Error {
  readonly code: RasterErrorCode;
  readonly retryable: boolean;

  constructor(code: RasterErrorCode, message: string, opts: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = new.target.name;
    this.code = code;
    this.retryable = opts.retryable ?? false;
  }
}

/**
 * Reading an asset failed at the transport level (DNS, connection reset,
 * timeout, HTTP error). Retryable unless the server answered with a status
 * that will not change on retry (400, 404, 410, 416).
 */
export class AssetReadError extends RasterAnalyticsError {
  readonly status: number | null;
  readonly url: string | null;

  constructor(message: string, opts: { status?: number | null; url?: string | null; retryable?: boolean; cause?: unknown } = {}) {
    const status = opts.status ?? null;
    super("asset_read_failed", message, { retryable: opts.retryable ?? isRetryableStatus(status), cause: opts.cause });
    this.status = status;
    this.url = opts.url ?? null;
  }
}

/** The file was read but is not a raster this engine can use reliably (corrupt, rotated, unknown CRS, …). Permanent. */
export class InvalidRasterError extends RasterAnalyticsError {
  constructor(message: string, opts: { cause?: unknown; code?: "invalid_raster" | "unsupported_crs" | "crs_mismatch" } = {}) {
    super(opts.code ?? "invalid_raster", message, { retryable: false, cause: opts.cause });
  }
}

/** The EPSG code has no definition in projection.ts. Permanent. */
export class UnsupportedCrsError extends InvalidRasterError {
  readonly epsg: number | null;
  constructor(epsg: number | null, detail?: string) {
    super(
      `Unsupported coordinate reference system ${epsg === null ? "(none declared)" : `EPSG:${epsg}`}${detail ? `: ${detail}` : ""}. ` +
        "Supported: EPSG:4326, EPSG:3857, and WGS 84 / UTM zones (EPSG:32601–32660, 32701–32760).",
      { code: "unsupported_crs" },
    );
    this.epsg = epsg;
  }
}

/** A band's CRS differs from the analysis grid's CRS. Permanent: the engine never silently reprojects source pixels. */
export class CrsMismatchError extends InvalidRasterError {
  constructor(
    readonly expected: number,
    readonly actual: number,
    what = "Raster",
  ) {
    super(`${what} is in EPSG:${actual} but the analysis grid is EPSG:${expected}.`, { code: "crs_mismatch" });
  }
}

/** The requested grid exceeds the pixel budget. Permanent for the same AOI and resolution. */
export class RasterTooLargeError extends RasterAnalyticsError {
  constructor(
    readonly pixels: number,
    readonly maxPixels: number,
  ) {
    super(
      "raster_too_large",
      `The analysis grid would have ${pixels.toLocaleString("en-US")} pixels, above the limit of ${maxPixels.toLocaleString("en-US")}. Use a smaller area.`,
      { retryable: false },
    );
  }
}

/** Two grids that must be identical are not. Permanent (a programming or pairing error). */
export class GridMismatchError extends RasterAnalyticsError {
  constructor(message: string) {
    super("grid_mismatch", message, { retryable: false });
  }
}

/** The caller supplied inputs the analytic cannot use (missing band, missing scale/offset, AOI smaller than a pixel, …). Permanent. */
export class InvalidInputError extends RasterAnalyticsError {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super("invalid_input", message, { retryable: false });
    this.reason = reason;
  }
}

/** HTTP statuses for which an identical retry can never succeed. 401/403 are retryable: the usual cause is an expired signature that is re-issued on retry. */
export function isRetryableStatus(status: number | null): boolean {
  if (status === null) return true;
  return !(status === 400 || status === 404 || status === 405 || status === 410 || status === 416 || status === 501);
}

/** True when re-running the job later may succeed. Unknown errors are treated as retryable. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof RasterAnalyticsError) return err.retryable;
  return true;
}

/** Strip query string and fragment (signatures, SAS tokens) from a URL before it appears in a message. */
export function redactUrl(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}
