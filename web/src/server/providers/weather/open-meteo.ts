/**
 * Open-Meteo daily weather.
 *
 *   fetchDailyHistory   archive API (ERA5-based reanalysis) → record_kind
 *                       "model_estimate". Reanalysis is a model estimate for
 *                       a grid cell, never a station observation. The most
 *                       recent days can be preliminary and later revised.
 *   fetchDailyForecast  forecast API → record_kind "forecast" (issuedAt is
 *                       null: the API does not report the model run time).
 *
 * Licensing gate: the free API is licensed for non-commercial use only.
 * Requests are made only when OPEN_METEO_API_KEY is set (customer-* hosts,
 * &apikey=) or OPEN_METEO_ALLOW_NONCOMMERCIAL is true (the default outside
 * production); otherwise availability() is "disabled" with the reason and
 * calls throw ProviderError "unconfigured". Data are CC BY 4.0: attribution
 * "Weather data by Open-Meteo.com" is required.
 *
 * Day boundaries: daily values are aggregated over the location's local day
 * (timezone=auto). validFrom/validTo are that local midnight-to-midnight
 * interval expressed as UTC instants, computed from the returned IANA zone
 * (DST-aware) and falling back to the returned utc_offset_seconds.
 * Null values are skipped, never replaced by zero; units are checked against
 * WEATHER_VARIABLES and a mismatch is a bad_response.
 */
import { WEATHER_VARIABLES, type WeatherVariable } from "@/server/analytics/types";
import { env } from "@/server/config/env";
import { httpJson, ProviderError, type FetchLike } from "@/server/providers/http";
import type { ProviderAvailability, ProviderDescriptor, WeatherRecord, WeatherRecordKind } from "@/server/providers/types";

export const OPEN_METEO_ID = "open-meteo";

export const OPEN_METEO_DESCRIPTOR: ProviderDescriptor = {
  id: OPEN_METEO_ID,
  name: "Open-Meteo",
  kind: "weather",
  operator: "Open-Meteo.com",
  homepage: "https://open-meteo.com/",
  docsUrl: "https://open-meteo.com/en/docs",
  products: [
    {
      id: "open-meteo:historical-daily",
      name: "Daily historical weather (ERA5-based reanalysis)",
      collection: "historical-daily",
      kind: "weather",
      analytics: [],
      capabilities: { search: true, assetAccess: false },
      notes: "Grid-cell model estimates (resolution depends on the underlying reanalysis), not station observations. Recent days may be preliminary.",
    },
    {
      id: "open-meteo:forecast-daily",
      name: "Daily weather forecast",
      collection: "forecast-daily",
      kind: "weather",
      analytics: [],
      capabilities: { search: true, assetAccess: false },
      notes: "Up to 16 days. Forecast issue time is not reported by the API.",
    },
  ],
  licensing: {
    summary:
      "Data are licensed CC BY 4.0 (attribution required). The free API is for non-commercial use only; commercial use requires an API subscription (customer endpoints with an API key).",
    url: "https://open-meteo.com/en/licence",
    redistribution: "Permitted under CC BY 4.0: credit Open-Meteo with a link to https://open-meteo.com/ (“Weather data by Open-Meteo.com”) and indicate changes.",
    commercialUse: "requires_license",
    attribution: "Weather data by Open-Meteo.com",
  },
  credentials: { required: false, envVars: ["OPEN_METEO_API_KEY", "OPEN_METEO_ALLOW_NONCOMMERCIAL"] },
  updateCadence: "Forecasts update several times per day; the historical archive is extended daily (see provider docs).",
  delivery: "polling",
  rateLimit: "Free API (non-commercial): fewer than 10,000 calls/day, 5,000/hour, 600/minute per the terms of use; subscriptions per plan.",
};

export type OpenMeteoConfig = { apiKey?: string | null; allowNonCommercial?: boolean };

function config(cfg?: OpenMeteoConfig): { apiKey: string | null; allowNonCommercial: boolean } {
  return {
    apiKey: cfg && "apiKey" in cfg ? (cfg.apiKey ?? null) : (env.openMeteoApiKey() ?? null),
    allowNonCommercial: cfg?.allowNonCommercial ?? env.openMeteoAllowNonCommercial(),
  };
}

export function openMeteoAvailability(cfg?: OpenMeteoConfig): ProviderAvailability {
  const c = config(cfg);
  if (c.apiKey || c.allowNonCommercial) return { state: "available" };
  return {
    state: "disabled",
    reason:
      "Open-Meteo's free API is licensed for non-commercial use only. Set OPEN_METEO_API_KEY (commercial subscription), or OPEN_METEO_ALLOW_NONCOMMERCIAL=true for a non-commercial deployment.",
  };
}

// ── Local-day boundaries ──────────────────────────────────────

const dtfCache = new Map<string, Intl.DateTimeFormat>();

/** Offset of `timeZone` from UTC (ms) at instant `t`. Throws RangeError for an unknown zone. */
export function zoneOffsetMs(timeZone: string, t: number): number {
  let dtf = dtfCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    dtfCache.set(timeZone, dtf);
  }
  const parts: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(t))) if (p.type !== "literal") parts[p.type] = Number(p.value);
  const asUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** The UTC instant of local midnight at the start of `ymd` in `timeZone` (DST-aware). */
export function zonedMidnightUtc(ymd: string, timeZone: string): Date {
  const [y, m, d] = parseYmd(ymd);
  const wall = Date.UTC(y, m - 1, d);
  let t = wall - zoneOffsetMs(timeZone, wall);
  t = wall - zoneOffsetMs(timeZone, t);
  return new Date(t);
}

/**
 * [local midnight, next local midnight) for `ymd` as UTC instants. Uses the
 * IANA zone when it is known to the runtime, else the fixed UTC offset.
 */
export function localDayBoundsUtc(ymd: string, timeZone: string | null, utcOffsetSeconds: number): { from: Date; to: Date } {
  const next = addDays(ymd, 1);
  if (timeZone) {
    try {
      return { from: zonedMidnightUtc(ymd, timeZone), to: zonedMidnightUtc(next, timeZone) };
    } catch {
      /* unknown zone — fall back to the fixed offset */
    }
  }
  const [y, m, d] = parseYmd(ymd);
  const from = Date.UTC(y, m - 1, d) - utcOffsetSeconds * 1000;
  return { from: new Date(from), to: new Date(from + 86_400_000) };
}

export function addDays(ymd: string, days: number): string {
  const [y, m, d] = parseYmd(ymd);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function parseYmd(ymd: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) throw new RangeError(`Invalid date "${ymd}" (expected YYYY-MM-DD)`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) throw new RangeError(`Invalid date "${ymd}"`);
  return [y, mo, d];
}

// ── Requests ──────────────────────────────────────────────────

const DAILY: { api: string; variable: WeatherVariable }[] = [
  { api: "precipitation_sum", variable: "precipitation_mm" },
  { api: "temperature_2m_max", variable: "temperature_max_c" },
  { api: "temperature_2m_min", variable: "temperature_min_c" },
  { api: "et0_fao_evapotranspiration", variable: "et0_mm" },
  { api: "wind_speed_10m_max", variable: "wind_speed_max_ms" },
];
const FORECAST_EXTRA: { api: string; variable: WeatherVariable }[] = [
  { api: "precipitation_probability_max", variable: "precipitation_probability_pct" },
];

type DailyResponse = {
  latitude?: number;
  longitude?: number;
  utc_offset_seconds?: number;
  timezone?: string;
  daily_units?: Record<string, string>;
  daily?: Record<string, unknown[]>;
};

export type OpenMeteoOptions = OpenMeteoConfig & { fetchImpl?: FetchLike; signal?: AbortSignal; now?: () => Date };

/** Daily reanalysis for [start, end] (local dates, inclusive). Days not yet complete are excluded. */
export async function fetchDailyHistory(
  lat: number,
  lon: number,
  start: string | Date,
  end: string | Date,
  opts: OpenMeteoOptions = {},
): Promise<WeatherRecord[]> {
  const startYmd = toYmd(start);
  const endYmd = toYmd(end);
  if (startYmd > endYmd) throw new RangeError("start must not be after end");
  if (startYmd < "1940-01-01") throw new RangeError("Open-Meteo history starts on 1940-01-01");
  const spanDays = (Date.parse(`${endYmd}T00:00:00Z`) - Date.parse(`${startYmd}T00:00:00Z`)) / 86_400_000;
  if (spanDays > 1100) throw new RangeError("Request at most ~3 years of daily history per call");
  const now = (opts.now ?? (() => new Date()))();
  const records = await request("archive", lat, lon, { start_date: startYmd, end_date: endYmd }, DAILY, "model_estimate", opts);
  return records.filter((r) => r.validTo.getTime() <= now.getTime());
}

/** Daily forecast for today and the next `days − 1` days (1–16). */
export async function fetchDailyForecast(lat: number, lon: number, days: number, opts: OpenMeteoOptions = {}): Promise<WeatherRecord[]> {
  if (!Number.isInteger(days) || days < 1 || days > 16) throw new RangeError("days must be an integer between 1 and 16");
  return request("forecast", lat, lon, { forecast_days: String(days) }, [...DAILY, ...FORECAST_EXTRA], "forecast", opts);
}

async function request(
  api: "archive" | "forecast",
  lat: number,
  lon: number,
  params: Record<string, string>,
  vars: { api: string; variable: WeatherVariable }[],
  kind: WeatherRecordKind,
  opts: OpenMeteoOptions,
): Promise<WeatherRecord[]> {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new RangeError("Latitude must be within ±90 and longitude within ±180");
  }
  const availability = openMeteoAvailability(opts);
  if (availability.state !== "available") {
    throw new ProviderError(OPEN_METEO_ID, "unconfigured", availability.reason, { retryable: false });
  }
  const { apiKey } = config(opts);
  const host = api === "archive" ? "archive-api.open-meteo.com/v1/archive" : "api.open-meteo.com/v1/forecast";
  const search = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    ...params,
    daily: vars.map((v) => v.api).join(","),
    timezone: "auto",
    wind_speed_unit: "ms",
    precipitation_unit: "mm",
    temperature_unit: "celsius",
  });
  const publicUrl = `https://${host}?${search.toString()}`;
  if (apiKey) search.set("apikey", apiKey);
  const url = `https://${apiKey ? "customer-" : ""}${host}?${search.toString()}`;

  const res = await httpJson<DailyResponse>(url, { providerId: OPEN_METEO_ID, signal: opts.signal, fetchImpl: opts.fetchImpl, timeoutMs: 20_000 });
  const times = res.daily?.time;
  if (!Array.isArray(times) || typeof res.utc_offset_seconds !== "number") {
    throw new ProviderError(OPEN_METEO_ID, "bad_response", "Open-Meteo response is missing daily.time or utc_offset_seconds", { retryable: false });
  }
  for (const v of vars) {
    const unit = res.daily_units?.[v.api];
    const expected = WEATHER_VARIABLES[v.variable].unit;
    if (unit !== expected) {
      throw new ProviderError(OPEN_METEO_ID, "bad_response", `Unexpected unit for ${v.api}: ${String(unit)} (expected ${expected})`, { retryable: false });
    }
  }

  const out: WeatherRecord[] = [];
  times.forEach((t, i) => {
    if (typeof t !== "string") return;
    const { from, to } = localDayBoundsUtc(t, res.timezone ?? null, res.utc_offset_seconds!);
    for (const v of vars) {
      const value = res.daily?.[v.api]?.[i];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      out.push({
        providerId: OPEN_METEO_ID,
        recordKind: kind,
        variable: v.variable,
        value,
        unit: WEATHER_VARIABLES[v.variable].unit,
        validFrom: from,
        validTo: to,
        issuedAt: null,
        stationId: null,
        stationDistanceKm: null,
        sourceUrl: publicUrl,
      });
    }
  });
  return out;
}

function toYmd(d: string | Date): string {
  if (typeof d === "string") {
    parseYmd(d);
    return d;
  }
  if (Number.isNaN(d.getTime())) throw new RangeError("Invalid date");
  return d.toISOString().slice(0, 10);
}
