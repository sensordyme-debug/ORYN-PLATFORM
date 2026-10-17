/**
 * Public event feeds: validation (a malformed snapshot is never shown),
 * production gating, one shared upstream request per cache period, serving
 * the last good snapshot as stale when a refresh fails, and filtering.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { feedState } from "@/lib/public-events";
import { resetHostLimiter, type FetchLike } from "@/server/providers/http";
import { normalizeEarthquakes, normalizeWildfires } from "@/server/public-events/normalize";
import { publicEvents, resetPublicEventsCache } from "@/server/public-events/service";

const quake = (id: string, lon: number, lat: number, mag: number | null, time = Date.parse("2026-10-15T12:00:00Z"), extra: Record<string, unknown> = {}) => ({
  type: "Feature",
  id,
  geometry: { type: "Point", coordinates: [lon, lat, 8.2] },
  properties: { mag, time, updated: time + 60_000, place: "10 km N of Somewhere", status: "reviewed", type: "earthquake", magType: "ml", title: `M ${mag} - Somewhere`, url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`, tsunami: 0, ...extra },
});
const usgs = (features: unknown[]) => ({ type: "FeatureCollection", metadata: { generated: Date.parse("2026-10-16T00:00:00Z") }, features });
const square = (lon: number, lat: number, d = 0.1) => ({ type: "Polygon", coordinates: [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]] });
const fire = (id: string, lon: number, lat: number, acres: number) => ({
  type: "Feature",
  geometry: square(lon, lat),
  properties: { poly_IncidentName: `Fire ${id}`, attr_UniqueFireIdentifier: id, attr_IncidentSize: acres, attr_PercentContained: 40, attr_POOState: "US-CO", attr_POOCounty: "Ouray", attr_IncidentTypeCategory: "WF", attr_FireDiscoveryDateTime: Date.parse("2026-09-01T00:00:00Z"), poly_DateCurrent: Date.parse("2026-10-14T00:00:00Z"), attr_FireCause: "Undetermined" },
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const NOW = Date.parse("2026-10-16T12:00:00Z");
const WORLD: [number, number, number, number] = [-180, -90, 180, 90];
const open = { production: false } as const;

beforeEach(() => {
  resetPublicEventsCache();
  resetHostLimiter();
});

describe("normalizeEarthquakes", () => {
  it("keeps M2.5+ events with their real times and a validated USGS link", () => {
    const rows = normalizeEarthquakes(usgs([quake("us1", -77.5, 35.9, 3.1), quake("us2", -77, 35, 2.1), quake("us3", 10, 10, null)]))!;
    expect(rows.map((r) => r.props.id)).toEqual(["us1"]);
    expect(rows[0]!.props).toMatchObject({ magnitude: 3.1, depthKm: 8.2, observedAt: "2026-10-15T12:00:00.000Z", reviewStatus: "reviewed", url: "https://earthquake.usgs.gov/earthquakes/eventpage/us1" });
  });

  it("rejects the whole snapshot when any record is malformed or duplicated", () => {
    expect(normalizeEarthquakes({})).toBeNull();
    expect(normalizeEarthquakes(usgs([quake("a", -77, 35, 3), quake("b", 200, 35, 3)]))).toBeNull();
    expect(normalizeEarthquakes(usgs([quake("a", -77, 35, 3), quake("a", -77, 35, 3)]))).toBeNull();
    expect(normalizeEarthquakes(usgs([quake("a", -77, 35, 11)]))).toBeNull();
  });

  it("never invents a time or trusts an unexpected link", () => {
    const [r] = normalizeEarthquakes(usgs([quake("a", -77, 35, 3, Number.NaN, { url: "https://evil.example/x" })]))!;
    expect(r!.props.observedAt).toBeNull();
    expect(r!.props.url).toBeNull();
  });
});

describe("normalizeWildfires", () => {
  it("merges pages, skips features without geometry, and keeps one row per fire", () => {
    const pages = [
      { type: "FeatureCollection", features: [fire("2026-CO-1", -107.7, 38, 39_747), { type: "Feature", geometry: null, properties: { attr_UniqueFireIdentifier: "x" } }] },
      { type: "FeatureCollection", features: [fire("2026-CO-1", -107.7, 38, 39_747), fire("2026-CA-2", -120, 37, 120)] },
    ];
    const out = normalizeWildfires(pages)!;
    expect(out.skipped).toBe(1);
    expect(out.records.map((r) => r.props.id)).toEqual(["2026-CO-1", "2026-CA-2"]);
    expect(out.records[0]!.props).toMatchObject({ acres: 39_747, percentContained: 40, state: "CO", county: "Ouray", observedAt: "2026-10-14T00:00:00.000Z" });
    out.records[0]!.bbox.forEach((v, i) => expect(v).toBeCloseTo([-107.7, 38, -107.6, 38.1][i]!, 9));
  });

  it("rejects a malformed page", () => {
    expect(normalizeWildfires([{ error: { code: 400 } }])).toBeNull();
    expect(normalizeWildfires([{ features: [{ geometry: { type: "Polygon", coordinates: [[[0, 0], [999, 0], [0, 1], [0, 0]]] }, properties: { attr_UniqueFireIdentifier: "x" } }] }])).toBeNull();
  });
});

describe("publicEvents service", () => {
  it("is off in production until verified, without calling the provider", async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const r = await publicEvents("usgs-earthquakes", { bbox: WORLD }, { production: true, verified: [], fetchImpl });
    expect(r!.feed.state).toBe("disabled");
    expect(r!.feed.message).toMatch(/oryn:verify -- usgs-earthquakes/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await publicEvents("not-a-layer", { bbox: WORLD }, open)).toBeNull();
  });

  it("shares one upstream request per cache period, then refreshes", async () => {
    let t = NOW;
    const fetchImpl = vi.fn<FetchLike>(async () => json(usgs([quake("us1", -77.5, 35.9, 3.1)])));
    const opts = { ...open, fetchImpl, now: () => t };
    const [a, b] = await Promise.all([publicEvents("usgs-earthquakes", { bbox: WORLD }, opts), publicEvents("usgs-earthquakes", { bbox: WORLD }, opts)]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(a!.feed).toMatchObject({ state: "nominal", retrievedAt: new Date(NOW).toISOString(), generatedAt: "2026-10-16T00:00:00.000Z" });
    expect(b!.total).toBe(1);
    t += 299_000;
    await publicEvents("usgs-earthquakes", { bbox: WORLD }, opts);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    t += 2_000;
    await publicEvents("usgs-earthquakes", { bbox: WORLD }, opts);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("serves the last good snapshot marked stale when a refresh fails, and backs off", async () => {
    let t = NOW;
    let fail = false;
    const fetchImpl = vi.fn<FetchLike>(async () => (fail ? json({ nope: true }) : json(usgs([quake("us1", -77.5, 35.9, 3.1)]))));
    const opts = { ...open, fetchImpl, now: () => t };
    await publicEvents("usgs-earthquakes", { bbox: WORLD }, opts);
    fail = true;
    t += 301_000;
    const r = await publicEvents("usgs-earthquakes", { bbox: WORLD }, opts);
    expect(r!.feed.state).toBe("stale");
    expect(r!.feed.message).toMatch(/could not validate/);
    expect(r!.total).toBe(1);
    expect(r!.feed.retrievedAt).toBe(new Date(NOW).toISOString());
    const calls = fetchImpl.mock.calls.length;
    t += 10_000;
    await publicEvents("usgs-earthquakes", { bbox: WORLD }, opts);
    expect(fetchImpl.mock.calls.length).toBe(calls); // waits out the backoff
  });

  it("reports unavailable, not empty, when there has never been data", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json({ message: "down" }, 404));
    const r = await publicEvents("nifc-wildfire-perimeters", { bbox: WORLD }, { ...open, fetchImpl, now: () => NOW });
    expect(r!.feed.state).toBe("unavailable");
    expect(r!.feed.message).toMatch(/National Interagency Fire Center/);
    expect(r!.features.features).toEqual([]);
  });

  it("follows WFIGS paging and filters by view, including across the antimeridian", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn<FetchLike>(async (url) => {
      urls.push(url);
      return url.includes("resultOffset")
        ? json({ type: "FeatureCollection", features: [fire("F-3", 179.85, -17, 50)] })
        : json({ type: "FeatureCollection", exceededTransferLimit: true, features: [fire("F-1", -107.7, 38, 500), fire("F-2", -120, 37, 1000)] });
    });
    const opts = { ...open, fetchImpl, now: () => NOW };
    const west = await publicEvents("nifc-wildfire-perimeters", { bbox: [-125, 30, -100, 45] }, opts);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("resultOffset=2");
    expect(west!.features.features.map((f) => f.properties.id)).toEqual(["F-2", "F-1"]); // largest first
    const dateline = await publicEvents("nifc-wildfire-perimeters", { bbox: [170, -30, -170, 0] }, opts);
    expect(dateline!.features.features.map((f) => f.properties.id)).toEqual(["F-3"]);
  });

  it("applies the look-back window to event time", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json(usgs([quake("new", 0, 0, 3, NOW - 3_600_000), quake("old", 0, 0, 4, NOW - 10 * 86_400_000)])));
    const r = await publicEvents("usgs-earthquakes", { bbox: WORLD, days: 7 }, { ...open, fetchImpl, now: () => NOW });
    expect(r!.features.features.map((f) => f.properties.id)).toEqual(["new"]);
  });
});

describe("feedState", () => {
  it("never calls cached or failing data current", () => {
    expect(feedState({ hasData: true })).toBe("nominal");
    expect(feedState({ hasData: true, error: true })).toBe("stale");
    expect(feedState({ hasData: false, error: true })).toBe("unavailable");
    expect(feedState({ hasData: false, loading: true })).toBe("loading");
    expect(feedState({ hasData: true, truncated: true })).toBe("partial");
    expect(feedState({ hasData: true, disabled: true })).toBe("disabled");
  });
});
