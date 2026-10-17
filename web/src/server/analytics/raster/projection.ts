/**
 * Coordinate transforms between WGS 84 longitude/latitude and the projected
 * CRSs that satellite assets are delivered in.
 *
 * Supported CRSs (definitions generated here, never fetched at runtime):
 *   EPSG:4326          WGS 84 geographic, axis order lon/lat (GeoJSON order)
 *   EPSG:3857          WGS 84 / Pseudo-Mercator
 *   EPSG:32601–32660   WGS 84 / UTM zones 1N–60N
 *   EPSG:32701–32760   WGS 84 / UTM zones 1S–60S
 * Anything else throws UnsupportedCrsError — the engine never guesses a CRS.
 *
 * Guarantees: UTM ↔ lon/lat round trips agree to well under 1 mm (proj4's
 * extended transverse Mercator). Polygon edges are straight lines in lon/lat
 * (RFC 7946), so projectMultiPolygon densifies long edges before projecting
 * to keep the projected outline faithful (≤ ~1 cm deviation for 0.01° steps).
 *
 * Limitations: no datum shifts other than WGS 84 identity; geometries that
 * cross the antimeridian are not split.
 */
import proj4 from "proj4";
import type { Position, Ring } from "@/lib/geo";
import { InvalidInputError, UnsupportedCrsError } from "../errors";

export const EPSG_WGS84 = 4326;
export const EPSG_WEB_MERCATOR = 3857;

/** PROJ string for a supported EPSG code, or null. */
export function projDefinition(epsg: number): string | null {
  if (epsg === EPSG_WGS84) return "+proj=longlat +datum=WGS84 +no_defs";
  if (epsg === EPSG_WEB_MERCATOR) {
    return "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs";
  }
  const utm = utmZoneOf(epsg);
  if (utm) return `+proj=utm +zone=${utm.zone}${utm.south ? " +south" : ""} +datum=WGS84 +units=m +no_defs`;
  return null;
}

export function isSupportedEpsg(epsg: number): boolean {
  return projDefinition(epsg) !== null;
}

/** True for CRSs whose units are degrees. */
export function isGeographic(epsg: number): boolean {
  return epsg === EPSG_WGS84;
}

/** UTM zone of a WGS 84 / UTM EPSG code (326zz north, 327zz south), else null. */
export function utmZoneOf(epsg: number): { zone: number; south: boolean } | null {
  if (!Number.isInteger(epsg)) return null;
  if (epsg >= 32601 && epsg <= 32660) return { zone: epsg - 32600, south: false };
  if (epsg >= 32701 && epsg <= 32760) return { zone: epsg - 32700, south: true };
  return null;
}

/** The WGS 84 / UTM EPSG code whose zone contains a lon/lat (standard 6° zones; Norway/Svalbard exceptions ignored). */
export function utmEpsgForLonLat(lon: number, lat: number): number {
  const zone = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
  return (lat >= 0 ? 32600 : 32700) + zone;
}

type Converter = { forward: (coordinates: number[]) => number[] };
const converters = new Map<string, Converter>();

function converter(fromEpsg: number, toEpsg: number): Converter {
  const key = `${fromEpsg}>${toEpsg}`;
  let c = converters.get(key);
  if (!c) {
    const from = projDefinition(fromEpsg);
    if (!from) throw new UnsupportedCrsError(fromEpsg);
    const to = projDefinition(toEpsg);
    if (!to) throw new UnsupportedCrsError(toEpsg);
    c = proj4(from, to);
    converters.set(key, c);
  }
  return c;
}

/** Transform one [x, y] position. Throws on unsupported CRSs or non-finite results. */
export function transformPoint(fromEpsg: number, toEpsg: number, p: Position): Position {
  if (fromEpsg === toEpsg) {
    if (!isSupportedEpsg(fromEpsg)) throw new UnsupportedCrsError(fromEpsg);
    return [p[0], p[1]];
  }
  const out = converter(fromEpsg, toEpsg).forward([p[0], p[1]]);
  const x = out[0];
  const y = out[1];
  if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new InvalidInputError(
      "projection_failed",
      `Position [${p[0]}, ${p[1]}] cannot be transformed from EPSG:${fromEpsg} to EPSG:${toEpsg}.`,
    );
  }
  return [x, y];
}

/** Insert intermediate vertices so no lon/lat segment spans more than maxStepDeg in either axis. */
function densifyRing(ring: Ring, maxStepDeg: number): Ring {
  if (!(maxStepDeg > 0) || ring.length < 2) return ring;
  const out: Ring = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i]!;
    const b = ring[i + 1]!;
    out.push(a);
    // The small tolerance keeps float noise (0.1 / 0.01 = 10.000000000000002) from adding a step.
    const steps = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / maxStepDeg - 1e-9);
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  out.push(ring[ring.length - 1]!);
  return out;
}

/**
 * Project MultiPolygon coordinates from lon/lat (EPSG:4326) into `epsg`.
 * Edges longer than `maxStepDeg` (default 0.01°) are densified first.
 */
export function projectMultiPolygon(coords: Ring[][], epsg: number, opts: { maxStepDeg?: number } = {}): Ring[][] {
  const step = opts.maxStepDeg ?? 0.01;
  if (epsg === EPSG_WGS84) return coords.map((poly) => poly.map((ring) => ring.map((p): Position => [p[0], p[1]])));
  return coords.map((poly) =>
    poly.map((ring) => densifyRing(ring, step).map((p) => transformPoint(EPSG_WGS84, epsg, p))),
  );
}

/** Unproject MultiPolygon coordinates from `epsg` to lon/lat. Vertices only (pixel-scale edges need no densification). */
export function unprojectMultiPolygon(coords: Ring[][], epsg: number): Ring[][] {
  return coords.map((poly) => poly.map((ring) => ring.map((p) => transformPoint(epsg, EPSG_WGS84, p))));
}

/** [minX, minY, maxX, maxY] of MultiPolygon coordinates. */
export function boundsOfMultiPolygon(coords: Ring[][]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of coords) {
    for (const ring of poly) {
      for (const p of ring) {
        if (p[0] < minX) minX = p[0];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[1] > maxY) maxY = p[1];
      }
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) throw new InvalidInputError("empty_geometry", "Geometry has no coordinates.");
  return [minX, minY, maxX, maxY];
}
