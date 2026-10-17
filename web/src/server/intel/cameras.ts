/**
 * Camera registry provider: Caltrans CWWP2 CCTV (12 district lists).
 *
 *  - Fixed upstream URLs; callers choose a bounding box, never a URL.
 *  - Lists change rarely ("as necessary"), so one shared snapshot is
 *    refreshed at most every 12 hours, on demand, with a single in-flight
 *    request. Districts that fail keep their previous cameras and the feed is
 *    reported partial; nothing at all is "unavailable".
 *  - Only in-service cameras, and only media URLs on Caltrans' own hosts,
 *    are returned. Video is never relayed through ORYN (the browser plays it
 *    directly; no Railway egress, nothing recorded).
 *  - In production this is a gated integration (`caltrans-cctv`).
 */
import { CAMERA_PROVIDERS, NO_CAMERA_ANALYTICS, type CameraRecord, type CamerasResponse, type StreamHealth } from "@/lib/intel/cameras";
import { integrationGate } from "@/server/integrations";
import { log } from "@/server/log";
import { httpJson, httpRequest, isProviderError, type FetchLike } from "@/server/providers/http";

export const CALTRANS_DISTRICTS = Array.from({ length: 12 }, (_, i) => i + 1);
export const caltransListUrl = (d: number) => `https://cwwp2.dot.ca.gov/data/d${d}/cctv/cctvStatusD${String(d).padStart(2, "0")}.json`;
const REFRESH_MS = 12 * 3_600_000;
const FAILURE_BACKOFF_MS = 30 * 60_000;
export const MAX_CAMERAS = 1500;

const STREAM_URL = /^https:\/\/wzmedia\.dot\.ca\.gov\/[A-Za-z0-9_.\-/]{1,200}\.m3u8$/;
const IMAGE_URL = /^https:\/\/cwwp2\.dot\.ca\.gov\/data\/d\d{1,2}\/cctv\/image\/[A-Za-z0-9_.\-/]{1,200}\.jpg$/;

type DistrictSnap = { cameras: CameraRecord[]; retrievedAt: number };
const state: { districts: Map<number, DistrictSnap>; failures: Map<number, string>; lastAttempt: number; inflight: Promise<void> | null } = {
  districts: new Map(),
  failures: new Map(),
  lastAttempt: 0,
  inflight: null,
};

const health = new Map<string, { at: number; result: StreamHealth }>();
const HEALTH_TTL_MS = 60_000;

/** Tests only. */
export function resetCameraCache(): void {
  state.districts.clear();
  state.failures.clear();
  state.lastAttempt = 0;
  state.inflight = null;
  health.clear();
}

const text = (v: unknown, max = 160) => (typeof v === "string" && v.trim() && v.trim() !== "Not Reported" ? v.trim().slice(0, max) : null);

/** One district's list → in-service cameras, or null when the list is malformed. */
export function normalizeCaltrans(district: number, payload: unknown): CameraRecord[] | null {
  const rows = (payload as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return null;
  const out: CameraRecord[] = [];
  for (const row of rows as { cctv?: Record<string, unknown> }[]) {
    const c = row?.cctv;
    if (!c || typeof c !== "object") return null;
    const loc = c.location as Record<string, unknown> | undefined;
    const img = c.imageData as { streamingVideoURL?: unknown; static?: { currentImageURL?: unknown; currentImageUpdateFrequency?: unknown } } | undefined;
    if (!loc || !img) return null;
    if (c.inService !== "true") continue;
    const lon = Number(loc.longitude);
    const lat = Number(loc.latitude);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90 || (lon === 0 && lat === 0)) continue;
    const stream = typeof img.streamingVideoURL === "string" && STREAM_URL.test(img.streamingVideoURL) ? img.streamingVideoURL : null;
    const image = typeof img.static?.currentImageURL === "string" && IMAGE_URL.test(img.static.currentImageURL) ? img.static.currentImageURL : null;
    if (!stream && !image) continue;
    const freq = Number(img.static?.currentImageUpdateFrequency);
    const index = text(c.index, 20) ?? `${out.length}`;
    out.push({
      id: `caltrans-cctv:${district}:${index}`,
      provider: "caltrans-cctv",
      name: text(loc.locationName) ?? `Caltrans D${district} camera ${index}`,
      lon,
      lat,
      route: text(loc.route, 20),
      direction: text(loc.direction, 20),
      nearby: text(loc.nearbyPlace, 80),
      district: `D${district}`,
      still: image ? { url: image, refreshMinutes: Number.isFinite(freq) && freq > 0 ? freq : null } : null,
      video: stream ? { hls: stream } : null,
    });
  }
  return out;
}

async function refresh(now: () => number, fetchImpl?: FetchLike) {
  state.lastAttempt = now();
  // Three at a time: polite to Caltrans, quick enough for an interactive request.
  const queue = [...CALTRANS_DISTRICTS];
  const worker = async () => {
    for (let d = queue.shift(); d !== undefined; d = queue.shift()) {
      try {
        const body = await httpJson(caltransListUrl(d), { providerId: "caltrans-cctv", timeoutMs: 20_000, retries: 1, maxBytes: 20 * 1024 * 1024, fetchImpl });
        const cams = normalizeCaltrans(d, body);
        if (!cams) throw new Error("malformed list");
        state.districts.set(d, { cameras: cams, retrievedAt: now() });
        state.failures.delete(d);
      } catch (e) {
        state.failures.set(d, isProviderError(e) && e.status ? `HTTP ${e.status}` : isProviderError(e) ? e.code : "malformed");
        log.warn("caltrans cctv district refresh failed", { district: d, code: isProviderError(e) ? e.code : "malformed" });
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

function intersects(lon: number, lat: number, [w, s, e, n]: [number, number, number, number]) {
  if (lat < s || lat > n) return false;
  return w <= e ? lon >= w && lon <= e : lon >= w || lon <= e;
}

export async function cameras(
  bbox: [number, number, number, number],
  opts: { now?: () => number; fetchImpl?: FetchLike; production?: boolean; verified?: string[]; q?: string } = {},
): Promise<CamerasResponse> {
  const provider = CAMERA_PROVIDERS["caltrans-cctv"];
  const now = opts.now ?? Date.now;
  const empty = (feed: CamerasResponse["feed"]): CamerasResponse => ({ provider, feed, analytics: NO_CAMERA_ANALYTICS, total: 0, cameras: [] });
  const gate = integrationGate("caltrans-cctv", { production: opts.production, verified: opts.verified });
  if (!gate.enabled) return empty({ state: "disabled", retrievedAt: null, message: gate.reason });

  const oldest = Math.min(...CALTRANS_DISTRICTS.map((d) => state.districts.get(d)?.retrievedAt ?? 0));
  const due = now() - oldest >= REFRESH_MS;
  const waiting = state.failures.size > 0 && now() - state.lastAttempt < FAILURE_BACKOFF_MS;
  if (due && !waiting) {
    state.inflight ??= refresh(now, opts.fetchImpl).finally(() => {
      state.inflight = null;
    });
    await state.inflight;
  }
  const snaps = [...state.districts.values()];
  if (!snaps.length) {
    return empty({ state: "unavailable", retrievedAt: null, message: "Caltrans camera lists could not be retrieved right now." });
  }
  const all = snaps.flatMap((s) => s.cameras);
  // A text query searches the whole registry (name, route, nearby place), ignoring the view; at most 25 results.
  const q = opts.q?.trim().toLowerCase();
  const matches = q
    ? all.filter((c) => [c.name, c.route, c.nearby].some((v) => v?.toLowerCase().includes(q))).slice(0, 25)
    : all.filter((c) => intersects(c.lon, c.lat, bbox));
  const failed = [...state.failures.keys()].sort((a, b) => a - b);
  const missing = CALTRANS_DISTRICTS.filter((d) => !state.districts.has(d));
  const retrievedAt = new Date(Math.min(...snaps.map((s) => s.retrievedAt))).toISOString();
  const notes = [
    failed.length ? `Districts ${failed.map((d) => `D${d}`).join(", ")} did not refresh${missing.length ? `; ${missing.map((d) => `D${d}`).join(", ")} have no cameras listed yet` : "; their previous lists are shown"}.` : null,
    matches.length > MAX_CAMERAS ? `Showing an even sample of ${MAX_CAMERAS} of ${matches.length} cameras in view; zoom in to see all of them.` : null,
  ].filter(Boolean);
  return {
    provider,
    feed: { state: missing.length ? "partial" : failed.length ? "stale" : matches.length > MAX_CAMERAS ? "partial" : "nominal", retrievedAt, message: notes.length ? notes.join(" ") : null },
    analytics: NO_CAMERA_ANALYTICS,
    total: matches.length,
    // Over the limit, an even sample keeps coverage spread across the view instead of favouring the first districts.
    cameras: matches.length > MAX_CAMERAS ? matches.filter((_, i) => i % Math.ceil(matches.length / MAX_CAMERAS) === 0) : matches,
  };
}

/**
 * Is this camera's live stream up? A HEAD request to the playlist URL from
 * the registry (never a URL from the caller), cached 60 s per camera. The
 * browser cannot tell an offline stream from a network fault (the stream
 * server's error responses carry no CORS headers); the server can.
 */
export async function streamHealth(
  cameraId: string,
  opts: { now?: () => number; fetchImpl?: FetchLike; production?: boolean; verified?: string[] } = {},
): Promise<StreamHealth | null> {
  const now = opts.now ?? Date.now;
  const gate = integrationGate("caltrans-cctv", { production: opts.production, verified: opts.verified });
  if (!gate.enabled) return null;
  if (!state.districts.size) await cameras([-180, -90, 180, 90], opts);
  const cam = [...state.districts.values()].flatMap((d) => d.cameras).find((c) => c.id === cameraId);
  if (!cam) return null;
  const cached = health.get(cameraId);
  if (cached && now() - cached.at < HEALTH_TTL_MS) return cached.result;
  const checkedAt = new Date(now()).toISOString();
  let result: StreamHealth;
  if (!cam.video) {
    result = { cameraId, status: "no_video", httpStatus: null, checkedAt, message: "Caltrans publishes still images only for this camera." };
  } else {
    try {
      const r = await httpRequest(cam.video.hls, { providerId: "caltrans-cctv", method: "HEAD", timeoutMs: 8_000, retries: 0, maxBytes: 64 * 1024, fetchImpl: opts.fetchImpl });
      result = { cameraId, status: "online", httpStatus: r.status, checkedAt, message: "Caltrans' stream server is serving this camera's live stream." };
    } catch (e) {
      const status = isProviderError(e) ? (e.status ?? null) : null;
      result =
        status && status >= 400 && status < 500
          ? { cameraId, status: "offline", httpStatus: status, checkedAt, message: `Caltrans lists this camera, but its live stream is offline right now (HTTP ${status}). The still image may still update.` }
          : { cameraId, status: "unknown", httpStatus: status, checkedAt, message: "Caltrans' stream server did not answer the check; the stream may or may not play." };
    }
  }
  if (health.size > 5000) health.clear();
  health.set(cameraId, { at: now(), result });
  return result;
}
