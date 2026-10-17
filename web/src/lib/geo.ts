/**
 * Geospatial helpers shared by client and server. Pure functions only.
 * Coordinates are [longitude, latitude] in WGS 84 (EPSG:4326), per GeoJSON.
 */
import { z } from "zod";

export type Position = [number, number];
export type Ring = Position[];
export type PolygonGeometry = { type: "Polygon"; coordinates: Ring[] };
export type MultiPolygonGeometry = { type: "MultiPolygon"; coordinates: Ring[][] };
export type PointGeometry = { type: "Point"; coordinates: Position };
export type LineStringGeometry = { type: "LineString"; coordinates: Position[] };
export type Geometry = PolygonGeometry | MultiPolygonGeometry | PointGeometry | LineStringGeometry;
export type BBox = [west: number, south: number, east: number, north: number];

export const EARTH_RADIUS_M = 6_378_137;
export const MAX_VERTICES = 20_000;

const lon = z.number().finite().min(-180).max(180);
const lat = z.number().finite().min(-85.06).max(85.06);
// Accepts optional elevation/measure values but normalizes to 2D [lon, lat]:
// AOI geometry columns are 2D, and analyses here are planimetric.
const position = z
  .tuple([lon, lat])
  .rest(z.number().finite())
  .transform(([x, y]): Position => [x, y]);

function closedRing(min: number) {
  return z
    .array(position)
    .min(min)
    .refine((r) => r.length > 0 && r[0]![0] === r[r.length - 1]![0] && r[0]![1] === r[r.length - 1]![1], {
      message: "Polygon rings must be closed (first and last positions equal).",
    });
}

export const polygonSchema = z.object({ type: z.literal("Polygon"), coordinates: z.array(closedRing(4)).min(1).max(500) });
export const multiPolygonSchema = z.object({
  type: z.literal("MultiPolygon"),
  coordinates: z.array(z.array(closedRing(4)).min(1).max(500)).min(1).max(500),
});
export const pointSchema = z.object({ type: z.literal("Point"), coordinates: position });
export const lineStringSchema = z.object({ type: z.literal("LineString"), coordinates: z.array(position).min(2).max(MAX_VERTICES) });

/** Geometry accepted as AOI input. Points and lines require a buffer distance. */
export const aoiInputGeometrySchema = z
  .discriminatedUnion("type", [polygonSchema, multiPolygonSchema, pointSchema, lineStringSchema])
  .refine((g) => countVertices(g as Geometry) <= MAX_VERTICES, { message: `Geometry exceeds ${MAX_VERTICES} vertices.` });

export function countVertices(g: Geometry): number {
  switch (g.type) {
    case "Point":
      return 1;
    case "LineString":
      return g.coordinates.length;
    case "Polygon":
      return g.coordinates.reduce((n, r) => n + r.length, 0);
    case "MultiPolygon":
      return g.coordinates.reduce((n, p) => n + p.reduce((m, r) => m + r.length, 0), 0);
  }
}

export function bboxOf(g: Geometry): BBox {
  let w = Infinity,
    s = Infinity,
    e = -Infinity,
    n = -Infinity;
  const visit = (p: Position) => {
    if (p[0] < w) w = p[0];
    if (p[0] > e) e = p[0];
    if (p[1] < s) s = p[1];
    if (p[1] > n) n = p[1];
  };
  switch (g.type) {
    case "Point":
      visit(g.coordinates);
      break;
    case "LineString":
      g.coordinates.forEach(visit);
      break;
    case "Polygon":
      g.coordinates.forEach((r) => r.forEach(visit));
      break;
    case "MultiPolygon":
      g.coordinates.forEach((p) => p.forEach((r) => r.forEach(visit)));
      break;
  }
  return [w, s, e, n];
}

/**
 * Geodesic area of a ring on a sphere (m²), using the method of
 * Chamberlain & Duquette (2007). Accurate to well under 1% for field- and
 * city-scale polygons; the server recomputes authoritative areas in PostGIS.
 */
export function ringArea(ring: Ring): number {
  let total = 0;
  const n = ring.length;
  if (n < 4) return 0;
  for (let i = 0; i < n - 1; i++) {
    const [lon1, lat1] = ring[i]!;
    const [lon2, lat2] = ring[i + 1]!;
    total += toRad(lon2 - lon1) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }
  return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

export function polygonArea(coords: Ring[]): number {
  if (coords.length === 0) return 0;
  return Math.max(0, ringArea(coords[0]!) - coords.slice(1).reduce((a, r) => a + ringArea(r), 0));
}

export function geometryArea(g: Geometry): number {
  if (g.type === "Polygon") return polygonArea(g.coordinates);
  if (g.type === "MultiPolygon") return g.coordinates.reduce((a, p) => a + polygonArea(p), 0);
  return 0;
}

export const toRad = (d: number) => (d * Math.PI) / 180;
export const toDeg = (r: number) => (r * 180) / Math.PI;

/** Ground distance (m) represented by one screen pixel at a Web Mercator zoom level and latitude (512-px tiles, MapLibre). */
export function metersPerPixel(zoom: number, latitude: number): number {
  return (Math.cos(toRad(latitude)) * 2 * Math.PI * EARTH_RADIUS_M) / (512 * 2 ** zoom);
}

/**
 * Parse a coordinate string. Accepts "35.8968, -77.5358", "35.8968 -77.5358",
 * "-77.5358, 35.8968" only when unambiguous, and DMS like
 * 35°53'48"N 77°32'09"W. Returns [lon, lat] or null.
 */
export function parseCoordinates(input: string): Position | null {
  const s = input.trim();
  const dms = /^(\d{1,3})[°\s]+(\d{1,2})['′\s]+(\d{1,2}(?:\.\d+)?)["″]?\s*([NS])[\s,]+(\d{1,3})[°\s]+(\d{1,2})['′\s]+(\d{1,2}(?:\.\d+)?)["″]?\s*([EW])$/i.exec(s);
  if (dms) {
    const la = (+dms[1]! + +dms[2]! / 60 + +dms[3]! / 3600) * (dms[4]!.toUpperCase() === "S" ? -1 : 1);
    const lo = (+dms[5]! + +dms[6]! / 60 + +dms[7]! / 3600) * (dms[8]!.toUpperCase() === "W" ? -1 : 1);
    return valid(lo, la) ? [lo, la] : null;
  }
  const hemi = /^(-?\d+(?:\.\d+)?)\s*°?\s*([NS])[\s,]+(-?\d+(?:\.\d+)?)\s*°?\s*([EW])$/i.exec(s);
  if (hemi) {
    const la = Math.abs(+hemi[1]!) * (hemi[2]!.toUpperCase() === "S" ? -1 : 1);
    const lo = Math.abs(+hemi[3]!) * (hemi[4]!.toUpperCase() === "W" ? -1 : 1);
    return valid(lo, la) ? [lo, la] : null;
  }
  const dec = /^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/.exec(s);
  if (dec) {
    const a = +dec[1]!;
    const b = +dec[2]!;
    // Conventional "lat, lon" order; fall back to "lon, lat" only if lat is impossible.
    if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return [b, a];
    if (Math.abs(b) <= 90 && Math.abs(a) <= 180) return [a, b];
  }
  return null;
}

function valid(lo: number, la: number) {
  return Number.isFinite(lo) && Number.isFinite(la) && Math.abs(lo) <= 180 && Math.abs(la) <= 90;
}

export function formatLatLon([lo, la]: Position, digits = 5): string {
  return `${Math.abs(la).toFixed(digits)}° ${la >= 0 ? "N" : "S"}, ${Math.abs(lo).toFixed(digits)}° ${lo >= 0 ? "E" : "W"}`;
}

export function formatArea(m2: number): string {
  if (!Number.isFinite(m2)) return "—";
  const ha = m2 / 10_000;
  if (m2 >= 1_000_000) return `${(m2 / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 })} km² (${ha.toLocaleString("en-US", { maximumFractionDigits: 0 })} ha)`;
  if (ha >= 1) return `${ha.toLocaleString("en-US", { maximumFractionDigits: 1 })} ha (${(ha * 2.47105).toLocaleString("en-US", { maximumFractionDigits: 1 })} ac)`;
  return `${m2.toLocaleString("en-US", { maximumFractionDigits: 0 })} m²`;
}

export function bboxToPolygon([w, s, e, n]: BBox): PolygonGeometry {
  return { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
}

export function bboxCenter([w, s, e, n]: BBox): Position {
  return [(w + e) / 2, (s + n) / 2];
}
