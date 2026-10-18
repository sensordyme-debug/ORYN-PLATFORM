/**
 * Keyless live AIS from Fintraffic Digitraffic (Finland): vessel positions
 * and voyage data received by the Finnish coastal AIS network — the Gulf of
 * Finland, the Archipelago Sea, the Gulf of Bothnia and nearby Baltic waters.
 * Licence: Creative Commons 4.0 BY ("Source: Fintraffic / digitraffic.fi,
 * license CC 4.0 BY"), the same terms as the Fintraffic road cameras.
 *
 * Used as the vessel feed only when AISStream has no key and the server opts
 * in with AIS_FALLBACK=digitraffic. Positions are fetched on demand, at most
 * once a minute (vessel names and types every 30 minutes), and written into
 * the shared AIS cache, so rows, tracks and staleness behave as for AISStream.
 */
import { ingestAisPosition, pruneAisPositions } from './ais-store.js';

export const DIGITRAFFIC_LOCATIONS_URL =
  'https://meri.digitraffic.fi/api/ais/v1/locations';
export const DIGITRAFFIC_VESSELS_URL =
  'https://meri.digitraffic.fi/api/ais/v1/vessels';
export const DIGITRAFFIC_SOURCE =
  'Fintraffic Digitraffic AIS (Finnish coastal network; CC BY 4.0)';
export const DIGITRAFFIC_ATTRIBUTION =
  'Source: Fintraffic / digitraffic.fi, license CC 4.0 BY';
const LOCATIONS_MAX_AGE_MS = 60_000;
const VESSELS_MAX_AGE_MS = 30 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** Digitraffic asks clients to identify themselves. */
const HEADERS = {
  'Digitraffic-User': 'ORYN-GodsEyeView',
  Accept: 'application/json',
  'Accept-Encoding': 'gzip',
};

export function digitrafficFallbackEnabled(env = process.env) {
  return (
    String(env.AIS_FALLBACK || '')
      .trim()
      .toLowerCase() === 'digitraffic'
  );
}

/**
 * Positions in the shared cache's row shape, joined with vessel metadata.
 * @param {{features?: Array<{mmsi?:number, geometry?:{coordinates?:number[]}, properties?:Record<string, unknown>}>}} locations
 * @param {Map<number, Record<string, unknown>>} vessels  mmsi → metadata
 */
export function digitrafficPositions(locations, vessels = new Map()) {
  const out = [];
  for (const f of locations?.features ?? []) {
    const p = f?.properties ?? {};
    const mmsi = Number(f?.mmsi ?? p.mmsi);
    const [lon, lat] = f?.geometry?.coordinates ?? [];
    const epochMs = Number(p.timestampExternal);
    if (
      !Number.isInteger(mmsi) ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      !Number.isFinite(epochMs)
    )
      continue;
    const v = vessels.get(mmsi) ?? {};
    out.push({
      mmsi: String(mmsi),
      lat,
      lon,
      name: typeof v.name === 'string' ? v.name.trim() : '',
      imo: v.imo ? String(v.imo) : '',
      type:
        v.shipType === undefined || v.shipType === null
          ? ''
          : String(v.shipType),
      destination:
        typeof v.destination === 'string' ? v.destination.trim() : '',
      speed: p.sog,
      course: p.cog,
      // AIS heading 511 = not available; the cache rejects anything above 360.
      heading: p.heading,
      epochMs,
    });
  }
  return out;
}

/**
 * The fallback feed: refresh() fetches when the cache is older than a minute
 * and reports a status in AISStream's vocabulary ('live' when fresh).
 */
export function createDigitrafficFeed({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let locationsAt = 0;
  let vesselsAt = 0;
  let vessels = new Map();
  let lastError = null;
  let lastMessageAt = null;
  let inFlight = null;

  const get = async (url) => {
    const r = await fetchImpl(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!r.ok)
      throw new Error(
        `Digitraffic ${url.endsWith('vessels') ? 'vessels' : 'locations'} HTTP ${r.status}`,
      );
    return r.json();
  };

  async function run() {
    try {
      if (vesselsAt === 0 || now() - vesselsAt > VESSELS_MAX_AGE_MS) {
        const list = await get(DIGITRAFFIC_VESSELS_URL);
        vessels = new Map(
          (Array.isArray(list) ? list : []).map((v) => [Number(v.mmsi), v]),
        );
        vesselsAt = now();
      }
      const locations = await get(DIGITRAFFIC_LOCATIONS_URL);
      let stored = 0;
      for (const p of digitrafficPositions(locations, vessels))
        if (ingestAisPosition(p)) stored++;
      pruneAisPositions();
      locationsAt = now();
      lastMessageAt = new Date(locationsAt).toISOString();
      lastError = stored ? null : 'Digitraffic returned no vessel positions';
    } catch (error) {
      lastError = error?.message || 'Digitraffic request failed';
    }
  }

  return {
    /** Refresh if older than a minute; concurrent callers share one request. */
    async refresh() {
      if (locationsAt > 0 && now() - locationsAt < LOCATIONS_MAX_AGE_MS) return;
      inFlight ??= run().finally(() => {
        inFlight = null;
      });
      await inFlight;
    },
    snapshot() {
      const fresh =
        locationsAt > 0 && now() - locationsAt < 3 * LOCATIONS_MAX_AGE_MS;
      return {
        status:
          fresh && !lastError ? 'live' : locationsAt > 0 ? 'stale' : 'down',
        error: lastError,
        lastMessageAt,
        silentForMs: locationsAt > 0 ? now() - locationsAt : null,
        reconnectAttempt: 0,
        nextAttemptAt: null,
        staleAfterMs: 3 * LOCATIONS_MAX_AGE_MS,
        watchdog: 'polling',
      };
    },
  };
}
