/**
 * Validation and normalization of public event feeds. Each snapshot is
 * admitted whole or not at all: a malformed feed never replaces the last
 * good one (the caller keeps serving that, marked stale).
 *
 * Earthquake validation adapted from God's Eye View
 * (src/layers/earthquakes/records.js, https://github.com/bilawalsidhu/gods-eye-view,
 * MIT License, Copyright (c) 2026 Bilawal Sidhu — see THIRD_PARTY_NOTICES.md).
 */
import type { EarthquakeProps, WildfireProps } from "@/lib/public-events";

export type EventRecord<P> = { geometry: GeoJSON.Geometry; bbox: [number, number, number, number]; props: P; sortKey: number };

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown, max = 300): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
/** A missing or impossible timestamp is unknown — never the time ORYN received the response. */
const iso = (ms: unknown): string | null => {
  const n = finite(ms);
  return n !== null && n > 0 && n < 8.64e15 ? new Date(n).toISOString() : null;
};
const lonLatOk = (lon: unknown, lat: unknown) => typeof lon === "number" && typeof lat === "number" && Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90;

const USGS_EVENT_PAGE = /^https:\/\/earthquake\.usgs\.gov\/earthquakes\/eventpage\/[A-Za-z0-9_-]{1,40}$/;

/** USGS summary GeoJSON → records, or null when the snapshot is malformed. */
export function normalizeEarthquakes(payload: unknown): EventRecord<EarthquakeProps>[] | null {
  const features = (payload as { features?: unknown })?.features;
  if (!Array.isArray(features)) return null;
  const out: EventRecord<EarthquakeProps>[] = [];
  const ids = new Set<string>();
  for (const f of features as { id?: unknown; geometry?: { type?: unknown; coordinates?: unknown }; properties?: Record<string, unknown> }[]) {
    const c = f?.geometry?.coordinates;
    const p = f?.properties;
    if (!Array.isArray(c) || c.length < 2 || !p || typeof p !== "object" || Array.isArray(p) || (f.geometry!.type != null && f.geometry!.type !== "Point")) return null;
    const [lon, lat, depth] = c as unknown[];
    if (!lonLatOk(lon, lat)) return null;
    if (depth != null && finite(depth) === null) return null;
    const mag = p.mag;
    if (mag != null && (finite(mag) === null || (mag as number) > 10)) return null;
    // A missing magnitude cannot establish that the event meets M2.5+.
    if (mag == null || (mag as number) < 2.5) continue;
    const id = text(f.id, 64);
    if (!id || ids.has(id)) return null;
    ids.add(id);
    const url = text(p.url, 200);
    out.push({
      geometry: { type: "Point", coordinates: [lon as number, lat as number] },
      bbox: [lon as number, lat as number, lon as number, lat as number],
      sortKey: mag as number,
      props: {
        layer: "usgs-earthquakes",
        id,
        title: text(p.title) ?? `M ${(mag as number).toFixed(1)}`,
        magnitude: mag as number,
        magnitudeType: text(p.magType, 10),
        depthKm: finite(depth),
        place: text(p.place),
        observedAt: iso(p.time),
        updatedAt: iso(p.updated),
        reviewStatus: text(p.status, 20),
        eventType: text(p.type, 40) ?? "earthquake",
        tsunamiFlag: p.tsunami === 1,
        url: url && USGS_EVENT_PAGE.test(url) ? url : null,
      },
    });
  }
  return out;
}

function ringsOf(g: { type?: unknown; coordinates?: unknown }): number[][][] | null {
  if (g.type === "Polygon" && Array.isArray(g.coordinates)) return g.coordinates as number[][][];
  if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) return (g.coordinates as number[][][][]).flat();
  return null;
}

/**
 * WFIGS current perimeters (GeoJSON pages) → records, or null when a page is
 * malformed. Features without geometry are skipped and counted.
 */
export function normalizeWildfires(pages: unknown[]): { records: EventRecord<WildfireProps>[]; skipped: number } | null {
  const out: EventRecord<WildfireProps>[] = [];
  const ids = new Set<string>();
  let skipped = 0;
  for (const page of pages) {
    const features = (page as { features?: unknown })?.features;
    if (!Array.isArray(features)) return null;
    for (const f of features as { geometry?: { type?: unknown; coordinates?: unknown } | null; properties?: Record<string, unknown> }[]) {
      const p = f?.properties;
      if (!p || typeof p !== "object") return null;
      if (!f.geometry) {
        skipped++;
        continue;
      }
      const rings = ringsOf(f.geometry);
      if (!rings) return null;
      let w = 180, s = 90, e = -180, n = -90;
      for (const ring of rings) {
        if (!Array.isArray(ring) || ring.length < 4) return null;
        for (const pt of ring) {
          if (!Array.isArray(pt) || !lonLatOk(pt[0], pt[1])) return null;
          w = Math.min(w, pt[0]!); e = Math.max(e, pt[0]!); s = Math.min(s, pt[1]!); n = Math.max(n, pt[1]!);
        }
      }
      // A perimeter's identifier is stable across updates; repeated rows (several polygons of one fire) keep the first.
      const id = text(p.attr_UniqueFireIdentifier, 64) ?? text(p.poly_IncidentName, 120);
      if (!id) return null;
      if (ids.has(id)) continue;
      ids.add(id);
      const acres = finite(p.attr_IncidentSize);
      const contained = finite(p.attr_PercentContained);
      out.push({
        geometry: f.geometry as GeoJSON.Geometry,
        bbox: [w, s, e, n],
        sortKey: acres ?? 0,
        props: {
          layer: "nifc-wildfire-perimeters",
          id,
          title: text(p.poly_IncidentName, 120) ?? id,
          acres: acres !== null && acres >= 0 ? acres : null,
          percentContained: contained !== null && contained >= 0 && contained <= 100 ? contained : null,
          state: text(p.attr_POOState, 10)?.replace(/^US-/, "") ?? null,
          county: text(p.attr_POOCounty, 80),
          incidentType: text(p.attr_IncidentTypeCategory, 10),
          cause: text(p.attr_FireCause, 60),
          discoveredAt: iso(p.attr_FireDiscoveryDateTime),
          observedAt: iso(p.poly_DateCurrent),
        },
      });
    }
  }
  return { records: out, skipped };
}
