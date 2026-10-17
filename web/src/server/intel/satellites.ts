/**
 * Imaging-satellite tracks and overpasses for the intelligence globe.
 *
 *  - Orbital elements come from CelesTrak (two fixed queries). CelesTrak
 *    updates them every 2 hours and blocks clients that download more often,
 *    so one shared snapshot is fetched at most once per 2 hours; after a
 *    failure the next attempt waits 30 minutes (or Retry-After).
 *  - A failed refresh keeps the last good elements (they stay usable for
 *    days, with growing error) and the feed is reported stale.
 *  - Browsers receive computed positions only, never the raw element sets.
 *  - In production this is a gated integration (`celestrak`).
 */
import { IMAGING_SATELLITES, type ImagingSatellite, type Overpass, type OverpassResponse, type SatelliteTracksResponse } from "@/lib/intel/satellites";
import { integrationGate } from "@/server/integrations";
import { log } from "@/server/log";
import { httpJson, isProviderError, ProviderError, type FetchLike } from "@/server/providers/http";
import { findPasses, positionAt, sampleTrack, satrecFromOmm } from "@/server/intel/orbits";
import type { OMMJsonObject, SatRec } from "satellite.js";

export const CELESTRAK_URLS = [
  "https://celestrak.org/NORAD/elements/gp.php?GROUP=resource&FORMAT=json",
  "https://celestrak.org/NORAD/elements/gp.php?NAME=SENTINEL-1&FORMAT=json",
];
const REFRESH_MS = 2 * 3_600_000;
const FAILURE_BACKOFF_MS = 30 * 60_000;
/** Elements older than this at the requested time are reported as stale. */
const STALE_ELEMENTS_HOURS = 72;
/** SGP4 is not useful far from the elements' epoch; requests are limited to this range around now. */
export const MAX_OFFSET_DAYS = 7;

type Elements = { omm: OMMJsonObject; satrec: SatRec; epochMs: number };
type Snapshot = { byId: Map<number, Elements>; retrievedAt: number };
const state: { snap: Snapshot | null; failure: { message: string; at: number; retryAfterMs: number } | null; inflight: Promise<void> | null } = {
  snap: null,
  failure: null,
  inflight: null,
};

/** Tests only. */
export function resetSatelliteCache(): void {
  state.snap = null;
  state.failure = null;
  state.inflight = null;
}

const WANTED = new Set(IMAGING_SATELLITES.map((s) => s.noradId));

/** Validate CelesTrak OMM arrays; null when malformed. Unknown satellites are ignored. */
export function normalizeOmm(payloads: unknown[]): Map<number, Elements> | null {
  const byId = new Map<number, Elements>();
  for (const p of payloads) {
    if (!Array.isArray(p)) return null;
    for (const r of p as Record<string, unknown>[]) {
      if (!r || typeof r !== "object" || typeof r.NORAD_CAT_ID !== "number" || typeof r.EPOCH !== "string" || typeof r.OBJECT_NAME !== "string") return null;
      if (!WANTED.has(r.NORAD_CAT_ID)) continue;
      const epochMs = Date.parse(r.EPOCH.endsWith("Z") ? r.EPOCH : `${r.EPOCH}Z`);
      if (!Number.isFinite(epochMs)) return null;
      const satrec = satrecFromOmm(r as unknown as OMMJsonObject);
      if (!satrec) return null;
      const prev = byId.get(r.NORAD_CAT_ID);
      if (!prev || prev.epochMs < epochMs) byId.set(r.NORAD_CAT_ID, { omm: r as unknown as OMMJsonObject, satrec, epochMs });
    }
  }
  return byId;
}

async function refresh(now: () => number, fetchImpl?: FetchLike) {
  try {
    const payloads: unknown[] = [];
    for (const url of CELESTRAK_URLS) {
      payloads.push(await httpJson(url, { providerId: "celestrak", timeoutMs: 20_000, retries: 0, maxBytes: 5 * 1024 * 1024, fetchImpl }));
    }
    const byId = normalizeOmm(payloads);
    if (!byId) throw new ProviderError("celestrak", "bad_response", "CelesTrak returned data ORYN could not validate.");
    state.snap = { byId, retrievedAt: now() };
    state.failure = null;
  } catch (e) {
    const status = isProviderError(e) ? e.status : undefined;
    const message =
      status === 403
        ? "CelesTrak refused the request (it temporarily blocks clients that download too often)."
        : isProviderError(e) && e.code === "bad_response"
          ? "CelesTrak returned data ORYN could not validate, so it was not used."
          : "CelesTrak is not available right now.";
    const retryAfterMs = isProviderError(e) && e.retryAfterMs ? Math.max(e.retryAfterMs, FAILURE_BACKOFF_MS) : FAILURE_BACKOFF_MS;
    state.failure = { message, at: now(), retryAfterMs };
    log.warn("celestrak refresh failed", { code: isProviderError(e) ? e.code : "error", status });
  }
}

type Opts = { now?: () => number; fetchImpl?: FetchLike; production?: boolean; verified?: string[] };

async function elements(opts: Opts): Promise<{ snap: Snapshot | null; feed: SatelliteTracksResponse["feed"] }> {
  const now = opts.now ?? Date.now;
  const gate = integrationGate("celestrak", { production: opts.production, verified: opts.verified });
  if (!gate.enabled) return { snap: null, feed: { state: "disabled", retrievedAt: null, message: gate.reason } };
  const due = !state.snap || now() - state.snap.retrievedAt >= REFRESH_MS;
  const waiting = state.failure !== null && now() - state.failure.at < state.failure.retryAfterMs;
  if (due && !waiting) {
    state.inflight ??= refresh(now, opts.fetchImpl).finally(() => {
      state.inflight = null;
    });
    await state.inflight;
  }
  const snap = state.snap;
  if (!snap) return { snap: null, feed: { state: "unavailable", retrievedAt: null, message: state.failure?.message ?? "No orbital elements yet." } };
  const stale = state.failure !== null;
  return {
    snap,
    feed: {
      state: stale ? "stale" : "nominal",
      retrievedAt: new Date(snap.retrievedAt).toISOString(),
      message: stale ? `${state.failure!.message} Using elements retrieved ${new Date(snap.retrievedAt).toISOString()}.` : null,
    },
  };
}

/** Computed tracks for every imaging satellite, ±`halfWindowMinutes` around `at`. */
export async function satelliteTracks(at: Date, opts: Opts & { halfWindowMinutes?: number; stepSeconds?: number } = {}): Promise<SatelliteTracksResponse> {
  const half = opts.halfWindowMinutes ?? 50;
  const step = opts.stepSeconds ?? 30;
  const { snap, feed } = await elements(opts);
  const t = at.getTime();
  const missing: string[] = [];
  const oldest: string[] = [];
  const satellites = IMAGING_SATELLITES.map((s) => {
    const el = snap?.byId.get(s.noradId);
    if (!el) {
      if (snap) missing.push(s.name);
      return { ...s, track: null };
    }
    const ageHours = Math.round(((t - el.epochMs) / 3_600_000) * 10) / 10;
    if (Math.abs(ageHours) > STALE_ELEMENTS_HOURS) oldest.push(s.name);
    const samples = sampleTrack(el.satrec, t - half * 60_000, t + half * 60_000, step);
    return { ...s, track: samples.length ? { noradId: s.noradId, name: s.name, elementsEpoch: new Date(el.epochMs).toISOString(), elementsAgeHours: ageHours, samples } : null };
  });
  const notes = [feed.message, missing.length ? `No current elements for ${missing.join(", ")}.` : null, oldest.length ? `Elements more than ${STALE_ELEMENTS_HOURS} h from the shown time for ${oldest.join(", ")}: positions are less accurate.` : null].filter(Boolean);
  return {
    feed: { ...feed, state: feed.state === "nominal" && (missing.length || oldest.length) ? "stale" : feed.state, message: notes.length ? notes.join(" ") : null },
    at: at.toISOString(),
    halfWindowMinutes: half,
    stepSeconds: step,
    satellites,
  };
}

/**
 * Upcoming geometric overpasses of a place: within half the swath, daylight
 * descending passes only for optical sensors (Sentinel-2 and Landsat image the
 * day side on descending passes); both directions for radar.
 */
export async function satelliteOverpasses(place: { lon: number; lat: number }, from: Date, days: number, opts: Opts = {}): Promise<OverpassResponse> {
  const { snap, feed } = await elements(opts);
  const passes: Overpass[] = [];
  if (snap) {
    const fromMs = from.getTime();
    const toMs = fromMs + days * 86_400_000;
    for (const s of IMAGING_SATELLITES as ImagingSatellite[]) {
      const el = snap.byId.get(s.noradId);
      if (!el || !positionAt(el.satrec, from)) continue;
      for (const p of findPasses(el.satrec, place, fromMs, toMs, s.swathKm / 2)) {
        if (s.optical && (p.direction !== "descending" || p.sunElevationDeg < 5)) continue;
        passes.push({ noradId: s.noradId, name: s.name, time: p.time.toISOString(), distanceKm: p.distanceKm, sunElevationDeg: p.sunElevationDeg, direction: p.direction });
      }
    }
  }
  passes.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  return { feed, place, fromIso: from.toISOString(), days, passes };
}
