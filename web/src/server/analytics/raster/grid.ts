/**
 * Analysis grids: north-up, axis-aligned pixel lattices in a source CRS.
 *
 * A Grid's transform uses GDAL order [originX, pixelW, 0, originY, 0, -pixelH]
 * (the same as RasterRef.transform): pixel (col, row) covers
 * x ∈ [originX + col·pixelW, originX + (col+1)·pixelW) and
 * y ∈ (originY − (row+1)·pixelH, originY − row·pixelH]. Its centre is
 * (originX + (col+½)·pixelW, originY − (row+½)·pixelH).
 *
 * gridForBounds snaps OUTWARD onto an existing source lattice, so analysis
 * pixels coincide exactly with the source band's pixels and the native band
 * is read without any resampling.
 *
 * Pixel areas:
 *   UTM          nominal pixelW·pixelH (projected area; the UTM scale factor,
 *                ≤ ±0.1 % in area within a zone, is not corrected).
 *   EPSG:3857    pixelW·pixelH·cos²(latitude of the row centre).
 *   EPSG:4326    exact area of the latitude band on the WGS 84 ellipsoid,
 *                computed per row.
 */
import type { Position } from "@/lib/geo";
import type { RasterRef } from "../types";
import { InvalidInputError, RasterTooLargeError } from "../errors";
import { EPSG_WEB_MERCATOR, EPSG_WGS84, transformPoint } from "./projection";

export type Affine = [number, number, number, number, number, number];
export type Grid = { width: number; height: number; epsg: number; transform: Affine };
/** [minX, minY, maxX, maxY] in the grid's CRS. */
export type Bounds = [number, number, number, number];

/** Hard ceiling on analysis grid size (≈ 50 km × 50 km at 10 m). */
export const DEFAULT_MAX_PIXELS = 25_000_000;

const WGS84_A = 6_378_137;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const WGS84_E = Math.sqrt(WGS84_E2);

/** Snap values within 1e-9 pixel of an integer onto it, absorbing floating-point noise from coordinate arithmetic. */
function snapNearInteger(v: number): number {
  const r = Math.round(v);
  return Math.abs(v - r) < 1e-9 ? r : v;
}

export function assertPixelBudget(width: number, height: number, maxPixels = DEFAULT_MAX_PIXELS): void {
  const n = width * height;
  if (!Number.isFinite(n) || n > maxPixels) throw new RasterTooLargeError(n, maxPixels);
}

/**
 * Smallest grid on the lattice (alignOrigin, pixelSize) that covers `bounds`.
 * Bounds edges lying exactly on lattice lines do not add an extra pixel.
 */
export function gridForBounds(
  bounds: Bounds,
  pixelSize: number | [number, number],
  alignOrigin: [number, number],
  epsg: number,
  opts: { maxPixels?: number } = {},
): Grid {
  const [pw, ph] = typeof pixelSize === "number" ? [pixelSize, pixelSize] : pixelSize;
  const [minX, minY, maxX, maxY] = bounds;
  if (!(pw > 0) || !(ph > 0) || !Number.isFinite(pw) || !Number.isFinite(ph)) {
    throw new InvalidInputError("invalid_grid", `Pixel size must be positive (got ${pw} × ${ph}).`);
  }
  if (![minX, minY, maxX, maxY, alignOrigin[0], alignOrigin[1]].every(Number.isFinite) || maxX < minX || maxY < minY) {
    throw new InvalidInputError("invalid_grid", "Grid bounds must be finite with min ≤ max.");
  }
  const [ox, oy] = alignOrigin;
  const col0 = Math.floor(snapNearInteger((minX - ox) / pw));
  const col1 = Math.ceil(snapNearInteger((maxX - ox) / pw));
  const row0 = Math.floor(snapNearInteger((oy - maxY) / ph));
  const row1 = Math.ceil(snapNearInteger((oy - minY) / ph));
  const width = Math.max(1, col1 - col0);
  const height = Math.max(1, row1 - row0);
  assertPixelBudget(width, height, opts.maxPixels);
  return { width, height, epsg, transform: [ox + col0 * pw, pw, 0, oy - row0 * ph, 0, -ph] };
}

export function pixelSizeOf(grid: Grid): { pw: number; ph: number } {
  return { pw: grid.transform[1], ph: -grid.transform[5] };
}

export function pixelCenter(grid: Grid, col: number, row: number): Position {
  const [ox, pw, , oy, , nph] = grid.transform;
  return [ox + (col + 0.5) * pw, oy + (row + 0.5) * nph];
}

/** [minX, minY, maxX, maxY] of the grid's outer edges. */
export function gridBounds(grid: Grid): Bounds {
  const [ox, pw, , oy, , nph] = grid.transform;
  return [ox, oy + grid.height * nph, ox + grid.width * pw, oy];
}

/** Image corners in lon/lat: top-left, top-right, bottom-right, bottom-left (RasterRef.corners). */
export function gridCornersLonLat(grid: Grid): RasterRef["corners"] {
  const [minX, minY, maxX, maxY] = gridBounds(grid);
  const t = (p: Position): [number, number] => {
    const [x, y] = transformPoint(grid.epsg, EPSG_WGS84, p);
    return [x, y];
  };
  return [t([minX, maxY]), t([maxX, maxY]), t([maxX, minY]), t([minX, minY])];
}

/** q(φ) term of the authalic-latitude area formula on the WGS 84 ellipsoid. */
function authalicQ(phi: number): number {
  const s = Math.sin(phi);
  const es = WGS84_E * s;
  return s / (1 - WGS84_E2 * s * s) + Math.log((1 + es) / (1 - es)) / (2 * WGS84_E);
}

/** Exact area (m²) of the WGS 84 ellipsoid between two latitudes over a longitude span, all in degrees. */
export function ellipsoidCellAreaM2(lat1: number, lat2: number, dLonDeg: number): number {
  const rad = Math.PI / 180;
  return ((WGS84_B * WGS84_B * Math.abs(dLonDeg) * rad) / 2) * Math.abs(authalicQ(lat2 * rad) - authalicQ(lat1 * rad));
}

/** Ground area (m²) of one pixel in `row`. Constant for projected CRSs; varies by row for EPSG:4326 and EPSG:3857. */
export function pixelAreaM2(grid: Grid, row: number): number {
  const [, pw, , oy, , nph] = grid.transform;
  const ph = -nph;
  if (grid.epsg === EPSG_WGS84) {
    const top = oy - row * ph;
    return ellipsoidCellAreaM2(top - ph, top, pw);
  }
  if (grid.epsg === EPSG_WEB_MERCATOR) {
    const yc = oy - (row + 0.5) * ph;
    const lat = 2 * Math.atan(Math.exp(yc / WGS84_A)) - Math.PI / 2;
    const c = Math.cos(lat);
    return pw * ph * c * c;
  }
  return pw * ph;
}

/** Per-row pixel areas (m²), for loops that sum areas over many pixels. */
export function rowAreasM2(grid: Grid): Float64Array {
  const out = new Float64Array(grid.height);
  for (let r = 0; r < grid.height; r++) out[r] = pixelAreaM2(grid, r);
  return out;
}

/** Pixel area at the grid's centre row: exact for projected CRSs, representative for EPSG:4326. */
export function nominalPixelAreaM2(grid: Grid): number {
  return pixelAreaM2(grid, Math.floor(grid.height / 2));
}

/** Ground sample distance (m): pixel width for projected grids, √(centre-row pixel area) for geographic ones. */
export function nominalGsdM(grid: Grid): number {
  if (grid.epsg === EPSG_WGS84 || grid.epsg === EPSG_WEB_MERCATOR) return Math.sqrt(nominalPixelAreaM2(grid));
  return pixelSizeOf(grid).pw;
}

/** True when two grids have the same CRS, shape, and (within 1e-6 pixel) the same transform. */
export function sameGrid(a: Grid, b: Grid): boolean {
  if (a.epsg !== b.epsg || a.width !== b.width || a.height !== b.height) return false;
  const tol = 1e-6 * Math.min(Math.abs(a.transform[1]), Math.abs(a.transform[5]));
  return a.transform.every((v, i) => Math.abs(v - b.transform[i]!) <= tol);
}
