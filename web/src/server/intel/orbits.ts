/**
 * Orbit geometry for the intelligence globe: SGP4 propagation of published
 * orbital elements (satellite.js), sampled ground tracks, solar elevation,
 * and geometric overpass prediction. Computed, not observed — callers label
 * results as model output.
 */
import { eciToGeodetic, gstime, json2satrec, propagate, type OMMJsonObject, type SatRec } from "satellite.js";

const RAD = Math.PI / 180;
const EARTH_KM = 6371.0088;

export function satrecFromOmm(omm: OMMJsonObject): SatRec | null {
  try {
    const s = json2satrec(omm);
    return s.error ? null : s;
  } catch {
    return null;
  }
}

/** Sub-satellite point and height at `t`, or null when SGP4 fails (decayed / invalid elements). */
export function positionAt(satrec: SatRec, t: Date): { lon: number; lat: number; heightM: number } | null {
  const pv = propagate(satrec, t);
  if (!pv?.position) return null;
  const g = eciToGeodetic(pv.position, gstime(t));
  let lon = g.longitude / RAD;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  const lat = g.latitude / RAD;
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(g.height)) return null;
  return { lon, lat, heightM: g.height * 1000 };
}

/** Sampled track [unix ms, lon, lat, height m] over [from, to]. Stops at the first failed propagation. */
export function sampleTrack(satrec: SatRec, fromMs: number, toMs: number, stepSeconds: number): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (let t = fromMs; t <= toMs; t += stepSeconds * 1000) {
    const p = positionAt(satrec, new Date(t));
    if (!p) break;
    out.push([t, Math.round(p.lon * 1e5) / 1e5, Math.round(p.lat * 1e5) / 1e5, Math.round(p.heightM)]);
  }
  return out;
}

export function greatCircleKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const h = Math.sin(((lat2 - lat1) * RAD) / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(((lon2 - lon1) * RAD) / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Solar elevation angle at a place and time, degrees (low-precision almanac, ±0.5°). */
export function sunElevationDeg(lon: number, lat: number, t: Date): number {
  const d = t.getTime() / 86_400_000 + 2440587.5 - 2451545.0; // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmstDeg = ((((18.697374558 + 24.06570982441908 * d) % 24) + 24) % 24) * 15;
  const ha = (gmstDeg + lon) * RAD - ra;
  const el = Math.asin(Math.sin(lat * RAD) * Math.sin(dec) + Math.cos(lat * RAD) * Math.cos(dec) * Math.cos(ha));
  return el / RAD;
}

export type PassCandidate = { time: Date; distanceKm: number; direction: "ascending" | "descending"; sunElevationDeg: number };

/**
 * Times the sub-satellite point comes within `maxKm` of a place: coarse scan
 * every `stepSeconds`, then the closest approach refined to ~2 s.
 */
export function findPasses(satrec: SatRec, place: { lon: number; lat: number }, fromMs: number, toMs: number, maxKm: number, stepSeconds = 30): PassCandidate[] {
  const dist = (t: number) => {
    const p = positionAt(satrec, new Date(t));
    return p ? greatCircleKm(p.lon, p.lat, place.lon, place.lat) : Number.POSITIVE_INFINITY;
  };
  const step = stepSeconds * 1000;
  const out: PassCandidate[] = [];
  let prev = dist(fromMs);
  let cur = dist(fromMs + step);
  for (let t = fromMs + step; t + step <= toMs; t += step) {
    const next = dist(t + step);
    if (cur <= prev && cur <= next && cur < maxKm + 50) {
      // Golden-section refinement of the minimum within [t - step, t + step].
      let a = t - step;
      let b = t + step;
      const phi = (Math.sqrt(5) - 1) / 2;
      while (b - a > 2000) {
        const c = b - phi * (b - a);
        const d = a + phi * (b - a);
        if (dist(c) < dist(d)) b = d;
        else a = c;
      }
      const tm = (a + b) / 2;
      const dm = dist(tm);
      if (dm <= maxKm) {
        const before = positionAt(satrec, new Date(tm - 10_000));
        const after = positionAt(satrec, new Date(tm + 10_000));
        out.push({
          time: new Date(Math.round(tm)),
          distanceKm: Math.round(dm * 10) / 10,
          direction: before && after && after.lat >= before.lat ? "ascending" : "descending",
          sunElevationDeg: Math.round(sunElevationDeg(place.lon, place.lat, new Date(tm)) * 10) / 10,
        });
      }
    }
    prev = cur;
    cur = next;
  }
  return out;
}
