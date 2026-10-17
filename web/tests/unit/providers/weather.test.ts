import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetHostLimiter } from "@/server/providers/http";
import {
  aggregateDailyPrecipitation,
  clearNwsCache,
  fetchActiveAlerts,
  fetchDailyForecast as nwsForecast,
  fetchRecentObservations,
  getPointMetadata,
  haversineKm,
  mapAlert,
  mapForecastPeriods,
  nwsAvailability,
} from "@/server/providers/weather/nws";
import { fetchDailyForecast, fetchDailyHistory, localDayBoundsUtc, openMeteoAvailability } from "@/server/providers/weather/open-meteo";
import { fixtureJson, jsonResponse, mockFetch } from "./_mock-fetch";

beforeAll(() => {
  vi.stubEnv("LOG_LEVEL", "error");
});

beforeEach(() => {
  clearNwsCache();
  resetHostLimiter();
});

const LAT = 35.8968;
const LON = -77.5358;
const NOW = () => new Date("2026-10-15T19:50:00Z");
const UA = "(oryn.test, ops@oryn.test)";

function nwsRoutes(overrides: Record<string, unknown> = {}) {
  return mockFetch((url) => {
    const u = new URL(url);
    for (const [path, body] of Object.entries(overrides)) if (u.pathname === path) return jsonResponse(body);
    if (u.pathname.startsWith("/points/")) return jsonResponse(fixtureJson("nws-points.json"));
    if (u.pathname === "/gridpoints/RAH/113,68/forecast") return jsonResponse(fixtureJson("nws-forecast.json"));
    if (u.pathname === "/gridpoints/RAH/113,68/stations") return jsonResponse(fixtureJson("nws-stations.json"));
    if (u.pathname === "/stations/KPGV/observations") return jsonResponse(fixtureJson("nws-observations.json"));
    if (u.pathname.startsWith("/stations/")) return jsonResponse({ type: "FeatureCollection", features: [] });
    if (u.pathname === "/alerts/active") return jsonResponse(fixtureJson("nws-alerts.json"));
    return jsonResponse({ title: "Not Found" }, 404);
  });
}

describe("NWS availability", () => {
  it("requires NWS_USER_AGENT in production, and uses the default identification in development", async () => {
    const a = nwsAvailability({ userAgent: undefined, production: true });
    expect(a.state).toBe("unconfigured");
    expect(a.state !== "available" && a.reason).toContain("NWS_USER_AGENT");
    expect(nwsAvailability({ userAgent: undefined, production: false })).toEqual({ state: "available" });
    expect(nwsAvailability({ userAgent: UA, production: true })).toEqual({ state: "available" });

    // Independent of any NWS_USER_AGENT in the developer's environment.
    vi.stubEnv("NWS_USER_AGENT", "");
    try {
      const f = nwsRoutes();
      await expect(fetchActiveAlerts(LAT, LON, { fetchImpl: f, production: true })).rejects.toMatchObject({ code: "unconfigured" });
      expect(f.calls).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("sends the configured User-Agent", async () => {
    const f = nwsRoutes();
    await getPointMetadata(LAT, LON, { fetchImpl: f, userAgent: UA, now: NOW });
    expect((f.calls[0]!.init!.headers as Record<string, string>)["user-agent"]).toBe(UA);
  });
});

describe("NWS point metadata", () => {
  it("rounds to 4 decimals and caches for 24 hours", async () => {
    const f = nwsRoutes();
    let now = new Date("2026-10-15T00:00:00Z");
    const p = await getPointMetadata(35.89681234, -77.53581234, { fetchImpl: f, userAgent: UA, now: () => now });
    expect(f.calls[0]!.url).toBe("https://api.weather.gov/points/35.8968,-77.5358");
    expect(p).toMatchObject({ gridId: "RAH", gridX: 113, gridY: 68, timeZone: "America/New_York", city: "Tarboro", state: "NC" });
    await getPointMetadata(35.89679, -77.53579, { fetchImpl: f, userAgent: UA, now: () => now });
    expect(f.calls).toHaveLength(1);
    now = new Date("2026-10-16T00:00:01Z");
    await getPointMetadata(LAT, LON, { fetchImpl: f, userAgent: UA, now: () => now });
    expect(f.calls).toHaveLength(2);
  });
});

describe("NWS alerts", () => {
  it("maps active alerts to warnings (official text, times, geometry or null)", async () => {
    const f = nwsRoutes();
    const warnings = await fetchActiveAlerts(LAT, LON, { fetchImpl: f, userAgent: UA, now: NOW });
    const q = new URL(f.calls[0]!.url).searchParams;
    expect(q.get("point")).toBe("35.8968,-77.5358");
    expect(q.get("status")).toBe("actual");
    expect(warnings).toHaveLength(3);
    const [w] = warnings;
    expect(w).toMatchObject({
      providerId: "nws",
      externalId: "urn:oid:2.49.0.1.840.0.56d1d192b1624548776546a4adb4ee1f95766590.001.1",
      title: "Flood Warning",
      severity: "Severe",
      certainty: "Likely",
      urgency: "Expected",
      category: "Met",
    });
    expect(w!.start?.toISOString()).toBe("2026-10-16T04:00:00.000Z"); // onset 23:00 CDT
    expect(w!.end?.toISOString()).toBe("2026-10-16T15:00:00.000Z"); // ends 10:00 CDT
    expect(w!.publishedAt?.toISOString()).toBe("2026-10-15T19:48:00.000Z");
    expect(w!.description).toContain("Flood Warning issued October 15");
    expect(w!.geometry?.type).toBe("Polygon");
    expect(w!.sourceUrl).toMatch(/^https:\/\/api\.weather\.gov\/alerts\/urn:oid:/);
    expect(warnings[2]!.title).toBe("Small Craft Advisory");
    expect(warnings[2]!.geometry).toBeNull();
  });

  it("drops cancellations and non-actual messages", () => {
    const f = fixtureJson<{ features: { properties: Record<string, unknown> }[] }>("nws-alerts.json").features[0]!;
    expect(mapAlert({ ...f, properties: { ...f.properties, messageType: "Cancel" } })).toBeNull();
    expect(mapAlert({ ...f, properties: { ...f.properties, status: "Test" } })).toBeNull();
  });

  it("optionally resolves null alert geometry from the affected zones", async () => {
    const square = (x: number) => ({ type: "Polygon", coordinates: [[[x, 35], [x + 1, 35], [x + 1, 36], [x, 36], [x, 35]]] });
    const alerts = fixtureJson<{ features: { geometry: unknown; properties: { affectedZones: string[] } }[] }>("nws-alerts.json");
    const zones = alerts.features[2]!.properties.affectedZones.map((z) => new URL(z).pathname);
    const f = nwsRoutes(Object.fromEntries(zones.map((z, i) => [z, { geometry: square(-76 + i) }])));
    const warnings = await fetchActiveAlerts(LAT, LON, { fetchImpl: f, userAgent: UA, now: NOW, resolveZoneGeometry: true });
    expect(warnings[2]!.geometry?.type).toBe("MultiPolygon");
    expect(warnings[2]!.geometry?.type === "MultiPolygon" && warnings[2]!.geometry.coordinates).toHaveLength(zones.length);
  });
});

describe("NWS forecast", () => {
  it("maps day/night periods to max/min temperature (°C) and precipitation probability with issuance time", async () => {
    const f = nwsRoutes();
    const records = await nwsForecast(LAT, LON, { fetchImpl: f, userAgent: UA, now: NOW });
    expect(records.every((r) => r.recordKind === "forecast" && r.issuedAt?.toISOString() === "2026-10-15T18:35:32.000Z")).toBe(true);
    const temps = records.filter((r) => r.variable.startsWith("temperature")).map((r) => [r.variable, r.value, r.unit, r.validFrom.toISOString(), r.validTo.toISOString()]);
    expect(temps).toEqual([
      ["temperature_max_c", 31.1, "°C", "2026-10-15T19:00:00.000Z", "2026-10-15T22:00:00.000Z"],
      ["temperature_min_c", 17.8, "°C", "2026-10-15T22:00:00.000Z", "2026-10-16T10:00:00.000Z"],
      ["temperature_max_c", 31.1, "°C", "2026-10-16T10:00:00.000Z", "2026-10-16T22:00:00.000Z"],
      ["temperature_min_c", 12.2, "°C", "2026-10-16T22:00:00.000Z", "2026-10-17T10:00:00.000Z"],
    ]);
    expect(records.filter((r) => r.variable === "precipitation_probability_pct").map((r) => r.value)).toEqual([2, 4, 0, 57]);
    expect(records[0]!.sourceUrl).toBe("https://api.weather.gov/gridpoints/RAH/113,68/forecast");
  });

  it("accepts QuantitativeValue temperatures and skips periods without values", () => {
    const r = mapForecastPeriods(
      [
        { startTime: "2026-10-15T12:00:00Z", endTime: "2026-10-15T22:00:00Z", isDaytime: true, temperature: { value: 30, unitCode: "wmoUnit:degC" } },
        { startTime: "2026-10-15T22:00:00Z", endTime: "2026-10-16T10:00:00Z", isDaytime: false, temperature: null, probabilityOfPrecipitation: { value: null } },
      ],
      null,
      "https://api.weather.gov/x",
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ variable: "temperature_max_c", value: 30 });
  });
});

describe("NWS observations", () => {
  it("uses the nearest station by great-circle distance and never turns missing precipitation into zero", async () => {
    const f = nwsRoutes();
    const records = await fetchRecentObservations(LAT, LON, { fetchImpl: f, userAgent: UA, now: NOW, hours: 24 });
    const obsCall = f.calls.find((c) => c.url.includes("/stations/KPGV/observations"))!;
    expect(new URL(obsCall.url).searchParams.get("start")).toBe("2026-10-14T19:50:00.000Z");
    expect(records.every((r) => r.recordKind === "observation" && r.stationId === "KPGV")).toBe(true);
    expect(records[0]!.stationDistanceKm).toBeCloseTo(31.89, 1);
    const temps = records.filter((r) => r.variable === "temperature_c");
    expect(temps).toHaveLength(6);
    expect(temps.at(-1)).toMatchObject({ value: 31, unit: "°C" });
    expect(temps.at(-1)!.validFrom.toISOString()).toBe("2026-10-15T19:15:00.000Z");
    expect(records.filter((r) => r.variable === "relative_humidity_pct")).toHaveLength(6);
    // All precipitation values in the fixture are null → no precipitation records at all.
    expect(records.filter((r) => r.variable === "precipitation_mm")).toHaveLength(0);
  });

  it("computes station distance with the haversine formula", () => {
    expect(haversineKm([-77.5358, 35.8968], [-77.38506, 35.63742])).toBeCloseTo(31.89, 1);
  });

  const ctx = { stationId: "KTEST", distanceKm: 5, timeZone: "America/New_York", sourceUrl: "https://api.weather.gov/stations/KTEST/observations" };
  // Synthetic hourly reports (test input): routine reports at HH:53 local carry the hour's total; a special report at HH:20 carries a partial amount.
  function reports(startUtc: string, hours: number, skip: number[] = []) {
    const out: { t: Date; mm: number }[] = [];
    for (let k = 0; k < hours; k++) {
      if (skip.includes(k)) continue;
      const routine = new Date(Date.parse(startUtc) + k * 3_600_000);
      out.push({ t: routine, mm: 0.5 });
      out.push({ t: new Date(routine.getTime() - 33 * 60_000), mm: 0.2 });
    }
    return out;
  }

  it("aggregates a complete local day from hourly routine totals", () => {
    const r = aggregateDailyPrecipitation(reports("2026-10-14T04:53:00Z", 24), ctx);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ variable: "precipitation_mm", value: 12, recordKind: "observation", stationId: "KTEST" });
    expect(r[0]!.validFrom.toISOString()).toBe("2026-10-14T04:00:00.000Z");
    expect(r[0]!.validTo.toISOString()).toBe("2026-10-15T04:00:00.000Z");
  });

  it("emits nothing for a day with a missing hour", () => {
    expect(aggregateDailyPrecipitation(reports("2026-10-14T04:53:00Z", 24, [7]), ctx)).toEqual([]);
  });

  it("requires 25 hours on the DST fall-back day", () => {
    expect(aggregateDailyPrecipitation(reports("2026-11-01T04:53:00Z", 24), ctx)).toEqual([]);
    const r = aggregateDailyPrecipitation(reports("2026-11-01T04:53:00Z", 25), ctx);
    expect(r).toHaveLength(1);
    expect(r[0]!.value).toBe(12.5);
    expect(r[0]!.validTo.getTime() - r[0]!.validFrom.getTime()).toBe(25 * 3_600_000);
  });
});

describe("Open-Meteo", () => {
  const allow = { apiKey: null, allowNonCommercial: true };

  it("is disabled with the licensing reason when neither an API key nor non-commercial use is configured", async () => {
    const a = openMeteoAvailability({ apiKey: null, allowNonCommercial: false });
    expect(a.state).toBe("disabled");
    expect(a.state !== "available" && a.reason).toMatch(/non-commercial use only/);
    const f = mockFetch(() => jsonResponse({}));
    await expect(fetchDailyForecast(LAT, LON, 3, { apiKey: null, allowNonCommercial: false, fetchImpl: f })).rejects.toMatchObject({ code: "unconfigured" });
    expect(f.calls).toHaveLength(0);
    expect(openMeteoAvailability({ apiKey: "k", allowNonCommercial: false })).toEqual({ state: "available" });
  });

  it("maps archive days to model_estimate records over local-day boundaries in UTC", async () => {
    const f = mockFetch(() => jsonResponse(fixtureJson("open-meteo-archive.json")));
    const records = await fetchDailyHistory(LAT, LON, "2026-09-01", "2026-09-05", { ...allow, fetchImpl: f, now: NOW });
    const u = new URL(f.calls[0]!.url);
    expect(u.host).toBe("archive-api.open-meteo.com");
    expect(u.searchParams.get("timezone")).toBe("auto");
    expect(u.searchParams.get("wind_speed_unit")).toBe("ms");
    expect(u.searchParams.get("daily")).toBe("precipitation_sum,temperature_2m_max,temperature_2m_min,et0_fao_evapotranspiration,wind_speed_10m_max");
    expect(records).toHaveLength(25);
    expect(records.every((r) => r.recordKind === "model_estimate" && r.issuedAt === null && r.stationId === null)).toBe(true);
    const p1 = records.find((r) => r.variable === "precipitation_mm")!;
    expect(p1).toMatchObject({ value: 0.3, unit: "mm" });
    expect(p1.validFrom.toISOString()).toBe("2026-09-01T04:00:00.000Z");
    expect(p1.validTo.toISOString()).toBe("2026-09-02T04:00:00.000Z");
    expect(records.find((r) => r.variable === "wind_speed_max_ms")).toMatchObject({ value: 4.3, unit: "m/s" });
    expect(records.find((r) => r.variable === "et0_mm")).toMatchObject({ value: 4.89, unit: "mm" });
  });

  it("excludes days that have not finished and skips null values (never zero)", async () => {
    const body = fixtureJson<{ daily: Record<string, unknown[]> }>("open-meteo-archive.json");
    body.daily.precipitation_sum![1] = null;
    const f = mockFetch(() => jsonResponse(body));
    const records = await fetchDailyHistory(LAT, LON, "2026-09-01", "2026-09-05", { ...allow, fetchImpl: f, now: () => new Date("2026-09-05T12:00:00Z") });
    const precip = records.filter((r) => r.variable === "precipitation_mm").map((r) => r.validFrom.toISOString().slice(0, 10));
    expect(precip).toEqual(["2026-09-01", "2026-09-03", "2026-09-04"]);
  });

  it("maps forecast days including precipitation probability, with issuedAt null", async () => {
    const f = mockFetch(() => jsonResponse(fixtureJson("open-meteo-forecast.json")));
    const records = await fetchDailyForecast(LAT, LON, 3, { ...allow, fetchImpl: f });
    expect(new URL(f.calls[0]!.url).host).toBe("api.open-meteo.com");
    expect(records).toHaveLength(18);
    expect(records.every((r) => r.recordKind === "forecast" && r.issuedAt === null)).toBe(true);
    expect(records.filter((r) => r.variable === "precipitation_probability_pct").map((r) => r.value)).toEqual([2, 7, 68]);
  });

  it("uses the customer host and API key when subscribed, without exposing the key in sourceUrl", async () => {
    const f = mockFetch(() => jsonResponse(fixtureJson("open-meteo-forecast.json")));
    const records = await fetchDailyForecast(LAT, LON, 3, { apiKey: "secret-key", allowNonCommercial: false, fetchImpl: f });
    const u = new URL(f.calls[0]!.url);
    expect(u.host).toBe("customer-api.open-meteo.com");
    expect(u.searchParams.get("apikey")).toBe("secret-key");
    expect(records[0]!.sourceUrl).not.toContain("secret-key");
  });

  it("rejects unexpected units", async () => {
    const body = fixtureJson<{ daily_units: Record<string, string> }>("open-meteo-forecast.json");
    body.daily_units.wind_speed_10m_max = "km/h";
    const f = mockFetch(() => jsonResponse(body));
    await expect(fetchDailyForecast(LAT, LON, 3, { ...allow, fetchImpl: f })).rejects.toMatchObject({ code: "bad_response" });
  });

  it("computes DST-aware local-day boundaries and falls back to the fixed offset", () => {
    const fallBack = localDayBoundsUtc("2026-11-01", "America/New_York", -14400);
    expect(fallBack.from.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(fallBack.to.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    const fixed = localDayBoundsUtc("2026-11-01", "Not/A_Zone", -14400);
    expect(fixed.from.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(fixed.to.toISOString()).toBe("2026-11-02T04:00:00.000Z");
    expect(localDayBoundsUtc("2026-07-01", null, 19800).from.toISOString()).toBe("2026-06-30T18:30:00.000Z");
  });

  it("validates inputs", async () => {
    await expect(fetchDailyHistory(LAT, LON, "2026-09-05", "2026-09-01", allow)).rejects.toThrow(RangeError);
    await expect(fetchDailyHistory(LAT, LON, "2026-02-30", "2026-03-01", allow)).rejects.toThrow(RangeError);
    await expect(fetchDailyForecast(LAT, LON, 17, allow)).rejects.toThrow(RangeError);
    await expect(fetchDailyForecast(91, LON, 3, allow)).rejects.toThrow(RangeError);
  });
});
