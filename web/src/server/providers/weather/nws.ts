/**
 * U.S. National Weather Service API (api.weather.gov). U.S. coverage only.
 *
 *   getPointMetadata          /points/{lat},{lon} (4-decimal precision), cached
 *                             in memory for 24 h per rounded point.
 *   fetchActiveAlerts         /alerts/active?point=… → WeatherWarning[]
 *                             ("Actual" alerts only; cancellations dropped).
 *                             Alert geometry is often null — the alert then
 *                             applies to its affected zones; pass
 *                             resolveZoneGeometry to fetch those polygons.
 *   fetchDailyForecast        the 12-hour day/night forecast → "forecast"
 *                             records: daytime highs → temperature_max_c,
 *                             overnight lows → temperature_min_c, and
 *                             precipitation_probability_pct, each valid for
 *                             its period, issuedAt = the forecast updateTime.
 *   fetchRecentObservations   nearest reporting station (great-circle distance
 *                             from the query point) → "observation" records for
 *                             temperature_c and relative_humidity_pct at each
 *                             report time. Daily precipitation_mm is emitted
 *                             only for local days whose every hour has a
 *                             reported precipitationLastHour value (see
 *                             aggregateDailyPrecipitation). Missing values are
 *                             skipped, never treated as zero; values with
 *                             failed QC (X, B) are dropped.
 *
 * Identification: NWS requires a User-Agent naming the application and a
 * contact. NWS_USER_AGENT is used when set; outside production ORYN's default
 * User-Agent is used; in production without it the provider is unconfigured.
 */
import { WEATHER_VARIABLES } from "@/server/analytics/types";
import { env, isProduction } from "@/server/config/env";
import { httpJson, orynUserAgent, ProviderError, type FetchLike } from "@/server/providers/http";
import { zonedMidnightUtc, addDays } from "@/server/providers/weather/open-meteo";
import type { ProviderAvailability, ProviderDescriptor, WeatherRecord, WeatherWarning } from "@/server/providers/types";
import type { Geometry, Position } from "@/lib/geo";

export const NWS_ID = "nws";
const BASE = "https://api.weather.gov";

export const NWS_DESCRIPTOR: ProviderDescriptor = {
  id: NWS_ID,
  name: "U.S. National Weather Service API",
  kind: "weather",
  operator: "NOAA National Weather Service",
  homepage: "https://www.weather.gov/",
  docsUrl: "https://www.weather.gov/documentation/services-web-api",
  products: [
    {
      id: "nws:alerts",
      name: "Active watches, warnings and advisories",
      collection: "alerts",
      kind: "weather",
      analytics: [],
      capabilities: { search: true, assetAccess: false },
      notes: "Official warnings for a point. Geometry may be null; the alert then applies to its listed forecast/county zones.",
    },
    {
      id: "nws:forecast",
      name: "12-hour period forecast (day/night)",
      collection: "forecast",
      kind: "weather",
      analytics: [],
      capabilities: { search: true, assetAccess: false },
    },
    {
      id: "nws:observations",
      name: "Surface observations from the nearest station",
      collection: "observations",
      kind: "weather",
      analytics: [],
      capabilities: { search: true, assetAccess: false },
      notes: "Station observations, not areal estimates; the station distance is recorded with every value.",
    },
  ],
  licensing: {
    summary:
      "NWS information is in the public domain unless noted otherwise and may be used for any lawful purpose, provided it is not claimed as your own, does not imply NOAA/NWS endorsement, and modified content is not presented as official.",
    url: "https://www.weather.gov/disclaimer",
    redistribution: "Permitted; do not present modified NWS products as official.",
    commercialUse: "allowed",
    attribution: "Source: NOAA National Weather Service",
  },
  credentials: { required: false, envVars: ["NWS_USER_AGENT"] },
  updateCadence: "Alerts as issued; forecasts several times per day; observations typically hourly or more often.",
  delivery: "polling",
  rateLimit: "Not published; NWS documents a generous limit that clears within about 5 seconds when exceeded.",
};

export function nwsAvailability(cfg?: { userAgent?: string; production?: boolean }): ProviderAvailability {
  const ua = cfg && "userAgent" in cfg ? cfg.userAgent : env.nwsUserAgent();
  const production = cfg?.production ?? isProduction();
  if (!production) return { state: "available" };
  if (!ua) {
    return {
      state: "unconfigured",
      reason: "NWS_USER_AGENT is not set. api.weather.gov requires a User-Agent identifying the application and a contact, e.g. \"(oryn.example.com, ops@example.com)\".",
    };
  }
  // NWS asks for a way to reach the operator (email address or website).
  if (!/@|https?:\/\/|\b[a-z0-9-]+\.[a-z]{2,}\b/i.test(ua)) {
    return {
      state: "unconfigured",
      reason: "NWS_USER_AGENT must include a contact (email address or website), e.g. \"(oryn.example.com, ops@example.com)\".",
    };
  }
  return { state: "available" };
}

export type NwsOptions = {
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  now?: () => Date;
  /** Overrides NWS_USER_AGENT (tests). */
  userAgent?: string;
  production?: boolean;
};

function userAgent(opts: NwsOptions): string {
  const a = nwsAvailability({ userAgent: opts.userAgent ?? env.nwsUserAgent(), production: opts.production });
  if (a.state !== "available") throw new ProviderError(NWS_ID, "unconfigured", a.reason, { retryable: false });
  return opts.userAgent ?? env.nwsUserAgent() ?? orynUserAgent();
}

async function get<T>(url: string, opts: NwsOptions, query?: Record<string, string>): Promise<T> {
  const u = new URL(url);
  if (!u.href.startsWith(`${BASE}/`)) throw new ProviderError(NWS_ID, "bad_response", "Refusing to follow a non-NWS URL", { retryable: false });
  for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, v);
  return httpJson<T>(u.toString(), {
    providerId: NWS_ID,
    headers: { accept: "application/geo+json" },
    userAgent: userAgent(opts),
    signal: opts.signal,
    fetchImpl: opts.fetchImpl,
    timeoutMs: 20_000,
  });
}

// ── Point metadata ────────────────────────────────────────────

export type NwsPoint = {
  latitude: number;
  longitude: number;
  gridId: string;
  gridX: number;
  gridY: number;
  forecastUrl: string;
  forecastHourlyUrl: string | null;
  observationStationsUrl: string;
  countyZone: string | null;
  forecastZone: string | null;
  timeZone: string | null;
  city: string | null;
  state: string | null;
  sourceUrl: string;
};

const POINT_TTL_MS = 24 * 60 * 60 * 1000;
const pointCache = new Map<string, { value: NwsPoint; at: number }>();

export function clearNwsCache(): void {
  pointCache.clear();
  zoneCache.clear();
}

function checkLatLon(lat: number, lon: number) {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new RangeError("Latitude must be within ±90 and longitude within ±180");
  }
}

/** Grid and station metadata for a point (rounded to 4 decimals, as the API requires). */
export async function getPointMetadata(lat: number, lon: number, opts: NwsOptions = {}): Promise<NwsPoint> {
  checkLatLon(lat, lon);
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const nowMs = (opts.now ?? (() => new Date()))().getTime();
  const hit = pointCache.get(key);
  if (hit && nowMs - hit.at < POINT_TTL_MS) return hit.value;

  const url = `${BASE}/points/${key}`;
  const res = await get<{ properties?: Record<string, unknown> }>(url, opts);
  const p = res.properties ?? {};
  const rel = isRecord(p.relativeLocation) && isRecord(p.relativeLocation.properties) ? p.relativeLocation.properties : {};
  if (typeof p.gridId !== "string" || typeof p.gridX !== "number" || typeof p.gridY !== "number" || typeof p.forecast !== "string" || typeof p.observationStations !== "string") {
    throw new ProviderError(NWS_ID, "bad_response", "NWS point metadata is missing grid or forecast links", { retryable: false });
  }
  const value: NwsPoint = {
    latitude: Number(lat.toFixed(4)),
    longitude: Number(lon.toFixed(4)),
    gridId: p.gridId,
    gridX: p.gridX,
    gridY: p.gridY,
    forecastUrl: p.forecast,
    forecastHourlyUrl: str(p.forecastHourly),
    observationStationsUrl: p.observationStations,
    countyZone: str(p.county),
    forecastZone: str(p.forecastZone),
    timeZone: str(p.timeZone),
    city: str(rel.city),
    state: str(rel.state),
    sourceUrl: url,
  };
  if (pointCache.size >= 5000) pointCache.delete(pointCache.keys().next().value!);
  pointCache.set(key, { value, at: nowMs });
  return value;
}

// ── Alerts ────────────────────────────────────────────────────

type AlertFeature = { id?: string; geometry?: unknown; properties?: Record<string, unknown> };

const zoneCache = new Map<string, { geometry: Geometry | null; at: number }>();

/** Active official alerts covering a point. */
export async function fetchActiveAlerts(
  lat: number,
  lon: number,
  opts: NwsOptions & { resolveZoneGeometry?: boolean } = {},
): Promise<WeatherWarning[]> {
  checkLatLon(lat, lon);
  const res = await get<{ features?: AlertFeature[] }>(`${BASE}/alerts/active`, opts, { point: `${lat.toFixed(4)},${lon.toFixed(4)}`, status: "actual" });
  if (!Array.isArray(res.features)) throw new ProviderError(NWS_ID, "bad_response", "NWS alerts response has no features", { retryable: false });
  const out: WeatherWarning[] = [];
  for (const f of res.features) {
    const w = mapAlert(f);
    if (!w) continue;
    if (!w.geometry && opts.resolveZoneGeometry) {
      const affected = f.properties?.affectedZones;
      const zones = Array.isArray(affected) ? affected.filter((z): z is string => typeof z === "string") : [];
      w.geometry = await zonesGeometry(zones, opts);
    }
    out.push(w);
  }
  return out;
}

/** Map one NWS alert feature; returns null for non-actual messages and cancellations. */
export function mapAlert(f: AlertFeature): WeatherWarning | null {
  const p = f.properties ?? {};
  const id = str(p.id) ?? str(f.id);
  if (!id) return null;
  if (p.status !== undefined && p.status !== "Actual") return null;
  if (p.messageType === "Cancel") return null;
  const event = str(p.event);
  const headline = str(p.headline);
  const parts = [headline, str(p.description), str(p.instruction)].filter((x): x is string => Boolean(x));
  return {
    providerId: NWS_ID,
    externalId: id,
    title: event ?? headline ?? "NWS alert",
    description: parts.length ? parts.join("\n\n") : null,
    severity: str(p.severity),
    certainty: str(p.certainty),
    urgency: str(p.urgency),
    category: str(p.category),
    geometry: polygonal(f.geometry),
    start: date(p.onset) ?? date(p.effective),
    end: date(p.ends) ?? date(p.expires),
    publishedAt: date(p.sent),
    sourceUrl: str(p["@id"]) ?? (str(f.id)?.startsWith("http") ? str(f.id) : null),
  };
}

/** Union of zone polygons as a MultiPolygon; null if any zone fails (a partial area would understate the alert). */
async function zonesGeometry(zones: string[], opts: NwsOptions): Promise<Geometry | null> {
  if (zones.length === 0 || zones.length > 10) return null;
  const nowMs = (opts.now ?? (() => new Date()))().getTime();
  const polys: Position[][][] = [];
  for (const z of zones) {
    let entry = zoneCache.get(z);
    if (!entry || nowMs - entry.at >= POINT_TTL_MS) {
      try {
        const res = await get<{ geometry?: unknown }>(z, opts);
        entry = { geometry: polygonal(res.geometry), at: nowMs };
      } catch {
        return null;
      }
      zoneCache.set(z, entry);
    }
    const g = entry.geometry;
    if (!g) return null;
    if (g.type === "Polygon") polys.push(g.coordinates);
    else if (g.type === "MultiPolygon") polys.push(...g.coordinates);
  }
  return polys.length ? { type: "MultiPolygon", coordinates: polys } : null;
}

// ── Forecast ──────────────────────────────────────────────────

type ForecastPeriod = {
  startTime?: string;
  endTime?: string;
  isDaytime?: boolean;
  temperature?: number | { value?: number | null; unitCode?: string } | null;
  temperatureUnit?: string;
  probabilityOfPrecipitation?: { value?: number | null; unitCode?: string } | null;
};

/** Day/night period forecast as "forecast" records. */
export async function fetchDailyForecast(lat: number, lon: number, opts: NwsOptions = {}): Promise<WeatherRecord[]> {
  const point = await getPointMetadata(lat, lon, opts);
  const res = await get<{ properties?: { updateTime?: string; periods?: ForecastPeriod[] } }>(point.forecastUrl, opts);
  const periods = res.properties?.periods;
  if (!Array.isArray(periods)) throw new ProviderError(NWS_ID, "bad_response", "NWS forecast has no periods", { retryable: false });
  return mapForecastPeriods(periods, date(res.properties?.updateTime), point.forecastUrl);
}

export function mapForecastPeriods(periods: ForecastPeriod[], issuedAt: Date | null, sourceUrl: string): WeatherRecord[] {
  const out: WeatherRecord[] = [];
  for (const period of periods) {
    const from = date(period.startTime);
    const to = date(period.endTime);
    if (!from || !to) continue;
    const base = { providerId: NWS_ID, recordKind: "forecast" as const, validFrom: from, validTo: to, issuedAt, stationId: null, stationDistanceKm: null, sourceUrl };
    const c = temperatureC(period);
    if (c !== null && typeof period.isDaytime === "boolean") {
      const variable = period.isDaytime ? "temperature_max_c" : "temperature_min_c";
      out.push({ ...base, variable, value: c, unit: WEATHER_VARIABLES[variable].unit });
    }
    const pop = period.probabilityOfPrecipitation?.value;
    if (typeof pop === "number" && Number.isFinite(pop)) {
      out.push({ ...base, variable: "precipitation_probability_pct", value: pop, unit: WEATHER_VARIABLES.precipitation_probability_pct.unit });
    }
  }
  return out;
}

function temperatureC(p: ForecastPeriod): number | null {
  const t = p.temperature;
  if (typeof t === "number") {
    if (p.temperatureUnit === "F") return round1(((t - 32) * 5) / 9);
    if (p.temperatureUnit === "C") return t;
    return null;
  }
  if (t && typeof t === "object" && typeof t.value === "number") return toCelsius(t.value, t.unitCode);
  return null;
}

// ── Observations ──────────────────────────────────────────────

type QV = { value?: number | null; unitCode?: string; qualityControl?: string } | null | undefined;
type ObservationFeature = { properties?: { timestamp?: string; temperature?: QV; relativeHumidity?: QV; precipitationLastHour?: QV; station?: string } };

const BAD_QC = new Set(["X", "B"]);

/** Observations from the nearest station with data in the last `hours` (default 24, max 168). */
export async function fetchRecentObservations(lat: number, lon: number, opts: NwsOptions & { hours?: number } = {}): Promise<WeatherRecord[]> {
  const hours = opts.hours ?? 24;
  if (!Number.isFinite(hours) || hours <= 0 || hours > 168) throw new RangeError("hours must be between 1 and 168");
  const point = await getPointMetadata(lat, lon, opts);
  const stations = await get<{ features?: { geometry?: { coordinates?: unknown }; properties?: Record<string, unknown> }[] }>(
    point.observationStationsUrl,
    opts,
    { limit: "10" },
  );
  const ranked = (stations.features ?? [])
    .map((f) => {
      const c = f.geometry?.coordinates;
      const id = str(f.properties?.stationIdentifier);
      if (!id || !Array.isArray(c) || typeof c[0] !== "number" || typeof c[1] !== "number") return null;
      return { id, timeZone: str(f.properties?.timeZone), distanceKm: round2(haversineKm([lon, lat], [c[0], c[1]])) };
    })
    .filter((s): s is { id: string; timeZone: string | null; distanceKm: number } => s !== null)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  const end = (opts.now ?? (() => new Date()))();
  const start = new Date(end.getTime() - hours * 3_600_000);
  for (const station of ranked.slice(0, 3)) {
    const features = await stationObservations(station.id, start, end, opts);
    if (features.length === 0) continue;
    const sourceUrl = `${BASE}/stations/${station.id}/observations`;
    return mapObservations(features, { stationId: station.id, distanceKm: station.distanceKm, timeZone: station.timeZone ?? point.timeZone, sourceUrl });
  }
  return [];
}

async function stationObservations(stationId: string, start: Date, end: Date, opts: NwsOptions): Promise<ObservationFeature[]> {
  if (!/^[A-Z0-9]{3,8}$/i.test(stationId)) return [];
  let url: string | null = `${BASE}/stations/${encodeURIComponent(stationId)}/observations`;
  let query: Record<string, string> | undefined = { start: start.toISOString(), end: end.toISOString(), limit: "500" };
  const out: ObservationFeature[] = [];
  for (let page = 0; url && page < 5; page++) {
    const res: { features?: ObservationFeature[]; pagination?: { next?: string } } = await get(url, opts, query);
    const features = res.features ?? [];
    out.push(...features);
    url = features.length > 0 && typeof res.pagination?.next === "string" ? res.pagination.next : null;
    query = undefined;
  }
  return out;
}

export function mapObservations(
  features: ObservationFeature[],
  ctx: { stationId: string; distanceKm: number; timeZone: string | null; sourceUrl: string },
): WeatherRecord[] {
  const out: WeatherRecord[] = [];
  const seen = new Set<string>();
  const precip: { t: Date; mm: number }[] = [];
  for (const f of features) {
    const p = f.properties ?? {};
    const t = date(p.timestamp);
    if (!t || seen.has(t.toISOString())) continue;
    seen.add(t.toISOString());
    const base = {
      providerId: NWS_ID,
      recordKind: "observation" as const,
      validFrom: t,
      validTo: t,
      issuedAt: null,
      stationId: ctx.stationId,
      stationDistanceKm: ctx.distanceKm,
      sourceUrl: ctx.sourceUrl,
    };
    const temp = good(p.temperature);
    const c = temp ? toCelsius(temp.value, temp.unitCode) : null;
    if (c !== null) out.push({ ...base, variable: "temperature_c", value: c, unit: WEATHER_VARIABLES.temperature_c.unit });
    const rh = good(p.relativeHumidity);
    if (rh && (rh.unitCode ?? "wmoUnit:percent") === "wmoUnit:percent") {
      out.push({ ...base, variable: "relative_humidity_pct", value: round1(rh.value), unit: WEATHER_VARIABLES.relative_humidity_pct.unit });
    }
    const pr = good(p.precipitationLastHour);
    const mm = pr ? toMillimetres(pr.value, pr.unitCode) : null;
    if (mm !== null) precip.push({ t, mm });
  }
  out.push(...aggregateDailyPrecipitation(precip, ctx));
  return out.sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime() || a.variable.localeCompare(b.variable));
}

/**
 * Daily precipitation totals from hourly reports.
 *
 * precipitationLastHour on a routine METAR (issued around HH:51–HH:56) is the
 * total since the previous routine report; special reports in between carry
 * partial accumulations. Reports are grouped into routine windows
 * (HH−1:57, HH:57], and the largest value in each window is taken as that
 * hour's total. A local day gets a record only if every one of its hours
 * (23–25 across DST changes) has a reported value; otherwise nothing is
 * emitted for that day. Window edges sit within a few minutes of local
 * midnight, which is accepted as the stated approximation.
 */
export function aggregateDailyPrecipitation(
  reports: { t: Date; mm: number }[],
  ctx: { stationId: string; distanceKm: number; timeZone: string | null; sourceUrl: string },
): WeatherRecord[] {
  const HOUR = 3_600_000;
  const SHIFT = 57 * 60_000;
  const windows = new Map<number, number>();
  for (const r of reports) {
    const w = Math.floor((r.t.getTime() - SHIFT - 1) / HOUR);
    windows.set(w, Math.max(windows.get(w) ?? 0, r.mm));
  }
  // Window w spans (w·1h + 57 min, (w+1)·1h + 57 min]; assign it to the local day containing its midpoint.
  const byDay = new Map<string, { total: number; hours: number }>();
  for (const [w, mm] of windows) {
    const mid = w * HOUR + SHIFT + HOUR / 2;
    const ymd = localYmd(mid, ctx.timeZone);
    const d = byDay.get(ymd) ?? { total: 0, hours: 0 };
    d.total += mm;
    d.hours += 1;
    byDay.set(ymd, d);
  }
  const out: WeatherRecord[] = [];
  for (const [ymd, d] of byDay) {
    const from = dayStart(ymd, ctx.timeZone);
    const to = dayStart(addDays(ymd, 1), ctx.timeZone);
    const hoursInDay = Math.round((to.getTime() - from.getTime()) / HOUR);
    if (d.hours !== hoursInDay) continue;
    out.push({
      providerId: NWS_ID,
      recordKind: "observation",
      variable: "precipitation_mm",
      value: round1(d.total),
      unit: WEATHER_VARIABLES.precipitation_mm.unit,
      validFrom: from,
      validTo: to,
      issuedAt: null,
      stationId: ctx.stationId,
      stationDistanceKm: ctx.distanceKm,
      sourceUrl: ctx.sourceUrl,
    });
  }
  return out;
}

function localYmd(t: number, timeZone: string | null): string {
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
    } catch {
      /* fall through to UTC */
    }
  }
  return new Date(t).toISOString().slice(0, 10);
}

function dayStart(ymd: string, timeZone: string | null): Date {
  if (timeZone) {
    try {
      return zonedMidnightUtc(ymd, timeZone);
    } catch {
      /* fall through to UTC */
    }
  }
  return new Date(`${ymd}T00:00:00Z`);
}

// ── Helpers ───────────────────────────────────────────────────

/** Great-circle distance in km between [lon, lat] positions (mean Earth radius 6371.0088 km). */
export function haversineKm(a: Position, b: Position): number {
  const R = 6371.0088;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function good(q: QV): { value: number; unitCode?: string } | null {
  if (!q || typeof q.value !== "number" || !Number.isFinite(q.value)) return null;
  if (q.qualityControl && BAD_QC.has(q.qualityControl)) return null;
  return { value: q.value, unitCode: q.unitCode };
}

function toCelsius(v: number, unitCode: string | undefined): number | null {
  if (unitCode === undefined || unitCode === "wmoUnit:degC") return round1(v);
  if (unitCode === "wmoUnit:degF") return round1(((v - 32) * 5) / 9);
  if (unitCode === "wmoUnit:K") return round1(v - 273.15);
  return null;
}

function toMillimetres(v: number, unitCode: string | undefined): number | null {
  if (v < 0) return null;
  if (unitCode === "wmoUnit:mm") return v;
  if (unitCode === "wmoUnit:m") return v * 1000;
  return null;
}

function polygonal(g: unknown): Geometry | null {
  if (!isRecord(g) || !Array.isArray(g.coordinates)) return null;
  if (g.type === "Polygon") return { type: "Polygon", coordinates: g.coordinates as Position[][] };
  if (g.type === "MultiPolygon") return { type: "MultiPolygon", coordinates: g.coordinates as Position[][][] };
  return null;
}

function date(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
