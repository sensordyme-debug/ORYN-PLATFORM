/**
 * Public event feeds (USGS earthquakes, NIFC wildfire perimeters) for the map.
 *
 *  - Fixed upstream URLs only: callers choose a layer id, never a URL.
 *  - One snapshot per layer, shared by every organization (the data is
 *    public), refreshed at most once per cache period with a single shared
 *    in-flight request, so map traffic never multiplies upstream calls.
 *  - A failed or malformed refresh keeps the last good snapshot and serves it
 *    marked stale; with nothing to serve the feed is "unavailable". After a
 *    failure the next attempt waits (Retry-After when given, else 60 s).
 *  - In production each feed is a gated integration (src/server/integrations.ts).
 *
 * Caching and stale-on-failure follow God's Eye View's server provider
 * pattern (server/providers/firePerimeters.js, MIT — see THIRD_PARTY_NOTICES.md).
 */
import { isPublicEventLayerId, PUBLIC_EVENT_LAYERS, feedState, type PublicEventFeed, type PublicEventLayerId, type PublicEventProps, type PublicEventsResponse } from "@/lib/public-events";
import { integrationGate } from "@/server/integrations";
import { log } from "@/server/log";
import { httpJson, isProviderError, ProviderError, type FetchLike } from "@/server/providers/http";
import { normalizeEarthquakes, normalizeWildfires, type EventRecord } from "@/server/public-events/normalize";

export const USGS_FEED_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_month.geojson";
export const WFIGS_QUERY_URL =
  "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query";
const WFIGS_PARAMS = new URLSearchParams({
  where: "1=1",
  outFields: [
    "poly_IncidentName",
    "attr_UniqueFireIdentifier",
    "attr_IncidentSize",
    "attr_PercentContained",
    "attr_POOState",
    "attr_POOCounty",
    "attr_IncidentTypeCategory",
    "attr_FireDiscoveryDateTime",
    "attr_FireCause",
    "poly_DateCurrent",
  ].join(","),
  // ~100 m simplification keeps a full season's perimeters around a megabyte.
  maxAllowableOffset: "0.001",
  outSR: "4326",
  f: "geojson",
});
/** The service returns at most 2,000 features per page. */
const WFIGS_MAX_PAGES = 10;
const FAILURE_BACKOFF_MS = 60_000;
export const MAX_FEATURES: Record<PublicEventLayerId, number> = { "usgs-earthquakes": 2000, "nifc-wildfire-perimeters": 400 };

type Snapshot = { records: EventRecord<PublicEventProps>[]; retrievedAt: number; generatedAt: number | null; skipped: number };
type Entry = { snap: Snapshot | null; failure: { message: string; at: number; retryAfterMs: number } | null; inflight: Promise<void> | null };

const cache = new Map<PublicEventLayerId, Entry>();

/** Tests only. */
export function resetPublicEventsCache(): void {
  cache.clear();
}

const PROVIDER_ID: Record<PublicEventLayerId, string> = { "usgs-earthquakes": "usgs-earthquakes", "nifc-wildfire-perimeters": "nifc-wfigs" };

async function fetchSnapshot(id: PublicEventLayerId, now: number, fetchImpl?: FetchLike): Promise<Snapshot> {
  const providerId = PROVIDER_ID[id];
  const opts = { providerId, timeoutMs: 15_000, retries: 1, maxBytes: 30 * 1024 * 1024, headers: { accept: "application/geo+json, application/json" }, fetchImpl };
  if (id === "usgs-earthquakes") {
    const payload = await httpJson<{ metadata?: { generated?: unknown } }>(USGS_FEED_URL, opts);
    const records = normalizeEarthquakes(payload);
    if (!records) throw new ProviderError(providerId, "bad_response", "The USGS feed was malformed.");
    const g = payload?.metadata?.generated;
    return { records, retrievedAt: now, generatedAt: typeof g === "number" && Number.isFinite(g) ? g : null, skipped: 0 };
  }
  const pages: unknown[] = [];
  let offset = 0;
  for (let page = 0; page < WFIGS_MAX_PAGES; page++) {
    const params = new URLSearchParams(WFIGS_PARAMS);
    if (offset) params.set("resultOffset", String(offset));
    const body = await httpJson<{ features?: unknown[]; exceededTransferLimit?: boolean; properties?: { exceededTransferLimit?: boolean } }>(`${WFIGS_QUERY_URL}?${params}`, opts);
    pages.push(body);
    const n = Array.isArray(body?.features) ? body.features.length : 0;
    offset += n;
    if (!(body?.exceededTransferLimit === true || body?.properties?.exceededTransferLimit === true) || n === 0) break;
  }
  const parsed = normalizeWildfires(pages);
  if (!parsed) throw new ProviderError(providerId, "bad_response", "The WFIGS response was malformed.");
  return { records: parsed.records, retrievedAt: now, generatedAt: null, skipped: parsed.skipped };
}

function failureMessage(id: PublicEventLayerId, e: unknown): string {
  const who = PUBLIC_EVENT_LAYERS[id].provider;
  if (!isProviderError(e)) return `${who} could not be reached.`;
  switch (e.code) {
    case "timeout":
      return `${who} did not respond in time.`;
    case "rate_limited":
      return `${who} is limiting requests; ORYN will retry later.`;
    case "bad_response":
      return `${who} returned data ORYN could not validate, so it was not shown.`;
    default:
      return `${who} is not available right now${e.status ? ` (HTTP ${e.status})` : ""}.`;
  }
}

async function refresh(id: PublicEventLayerId, entry: Entry, now: () => number, fetchImpl?: FetchLike) {
  try {
    entry.snap = await fetchSnapshot(id, now(), fetchImpl);
    entry.failure = null;
  } catch (e) {
    const retryAfterMs = isProviderError(e) && e.retryAfterMs ? Math.min(e.retryAfterMs, 15 * 60_000) : FAILURE_BACKOFF_MS;
    entry.failure = { message: failureMessage(id, e), at: now(), retryAfterMs };
    log.warn("public event feed refresh failed", { layer: id, code: isProviderError(e) ? e.code : "error", status: isProviderError(e) ? e.status : undefined });
  }
}

export type PublicEventsQuery = {
  /** west, south, east, north (degrees); west > east crosses the antimeridian. */
  bbox: [number, number, number, number];
  /** Look-back window for layers with a time range. */
  days?: number;
};

function intersects(b: [number, number, number, number], q: [number, number, number, number]): boolean {
  const [w, s, e, n] = q;
  if (b[1] > n || b[3] < s) return false;
  if (w <= e) return b[0] <= e && b[2] >= w;
  return b[0] <= e || b[2] >= w; // query crosses the antimeridian
}

export async function publicEvents(
  layerId: string,
  q: PublicEventsQuery,
  opts: { now?: () => number; fetchImpl?: FetchLike; production?: boolean; verified?: string[] } = {},
): Promise<PublicEventsResponse | null> {
  if (!isPublicEventLayerId(layerId)) return null;
  const layer = PUBLIC_EVENT_LAYERS[layerId];
  const now = opts.now ?? Date.now;
  const empty = (feed: PublicEventFeed): PublicEventsResponse => ({ layer, feed, total: 0, features: { type: "FeatureCollection", features: [] } });

  const gate = integrationGate(layerId, { production: opts.production, verified: opts.verified });
  if (!gate.enabled) return empty({ state: "disabled", retrievedAt: null, generatedAt: null, message: gate.reason, retryAfterSeconds: null });

  let entry = cache.get(layerId);
  if (!entry) cache.set(layerId, (entry = { snap: null, failure: null, inflight: null }));
  const ttlMs = layer.cacheSeconds * 1000;
  const fresh = entry.snap !== null && now() - entry.snap.retrievedAt < ttlMs;
  const waiting = entry.failure !== null && now() - entry.failure.at < entry.failure.retryAfterMs;
  if (!fresh && !waiting) {
    const e = entry;
    e.inflight ??= refresh(layerId, e, now, opts.fetchImpl).finally(() => {
      e.inflight = null;
    });
    await e.inflight;
  }

  const snap = entry.snap;
  const failure = entry.failure;
  const retryAfterSeconds = failure ? Math.max(0, Math.ceil((failure.at + failure.retryAfterMs - now()) / 1000)) : null;
  if (!snap) return empty({ state: "unavailable", retrievedAt: null, generatedAt: null, message: failure?.message ?? "No data yet.", retryAfterSeconds });

  const since = q.days && layer.windows ? now() - q.days * 86_400_000 : null;
  const matches = snap.records.filter((r) => {
    if (!intersects(r.bbox, q.bbox)) return false;
    if (since !== null) {
      const t = r.props.observedAt ? Date.parse(r.props.observedAt) : NaN;
      if (!(t >= since)) return false;
    }
    return true;
  });
  matches.sort((a, b) => b.sortKey - a.sortKey);
  const limit = MAX_FEATURES[layerId];
  const shown = matches.slice(0, limit);
  const stale = now() - snap.retrievedAt >= ttlMs;
  const state = feedState({ hasData: true, error: failure !== null, stale, truncated: matches.length > limit });
  const notes = [
    failure ? `${failure.message} Showing the snapshot retrieved ${new Date(snap.retrievedAt).toISOString()}.` : null,
    matches.length > limit ? `Showing the ${limit} largest of ${matches.length} in view; zoom in to see the rest.` : null,
    snap.skipped ? `${snap.skipped} record(s) without a mapped boundary were left out.` : null,
  ].filter(Boolean);
  return {
    layer,
    feed: {
      state: state === "loading" ? "nominal" : state,
      retrievedAt: new Date(snap.retrievedAt).toISOString(),
      generatedAt: snap.generatedAt ? new Date(snap.generatedAt).toISOString() : null,
      message: notes.length ? notes.join(" ") : null,
      retryAfterSeconds,
    },
    total: matches.length,
    features: { type: "FeatureCollection", features: shown.map((r) => ({ type: "Feature", geometry: r.geometry, properties: r.props })) },
  };
}
