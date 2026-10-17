/**
 * Intelligence globe sources: orbit geometry (checked against a real ORYN
 * acquisition), CelesTrak caching and failure states, the Caltrans camera
 * registry, and live-stream health. Network is never used: fetch is injected.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OMMJsonObject } from "satellite.js";
import { resetHostLimiter, type FetchLike } from "@/server/providers/http";
import { cameras, normalizeCaltrans, resetCameraCache, streamHealth } from "@/server/intel/cameras";
import { findPasses, greatCircleKm, positionAt, satrecFromOmm, sunElevationDeg } from "@/server/intel/orbits";
import { normalizeOmm, resetSatelliteCache, satelliteOverpasses, satelliteTracks } from "@/server/intel/satellites";

const OMM = JSON.parse(readFileSync("tests/fixtures/celestrak-resource.sample.json", "utf8")) as (OMMJsonObject & { NORAD_CAT_ID: number })[];
const CALTRANS = JSON.parse(readFileSync("tests/fixtures/caltrans-cctv-d7.sample.json", "utf8")) as { data: { cctv: Record<string, unknown> }[] };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const open = { production: false } as const;
const S2B = OMM.find((r) => r.NORAD_CAT_ID === 42063)!;

beforeEach(() => {
  resetSatelliteCache();
  resetCameraCache();
  resetHostLimiter();
});

describe("orbit geometry", () => {
  it("puts Sentinel-2B at its ~790 km altitude", () => {
    const p = positionAt(satrecFromOmm(S2B)!, new Date("2026-10-16T20:00:00Z"))!;
    expect(p.heightM).toBeGreaterThan(780_000);
    expect(p.heightM).toBeLessThan(820_000);
    expect(Math.abs(p.lat)).toBeLessThanOrEqual(82);
  });

  it("predicts ORYN's real Sentinel-2B acquisition over the Charlotte field (S2B_17SNV_20261014, 16:13 UTC)", () => {
    const passes = findPasses(satrecFromOmm(S2B)!, { lon: -80.73, lat: 35.306 }, Date.parse("2026-10-14T00:00:00Z"), Date.parse("2026-10-15T00:00:00Z"), 145);
    const day = passes.filter((p) => p.direction === "descending" && p.sunElevationDeg > 5);
    expect(day).toHaveLength(1);
    expect(Math.abs(day[0]!.time.getTime() - Date.parse("2026-10-14T16:13:30Z"))).toBeLessThan(90_000);
    expect(day[0]!.distanceKm).toBeLessThan(145);
  });

  it("computes the sun's elevation and great-circle distances", () => {
    // Near the March equinox the noon sun at the equator is close to overhead; at midnight it is far below.
    expect(sunElevationDeg(0, 0, new Date("2026-03-20T12:07:00Z"))).toBeGreaterThan(85);
    expect(sunElevationDeg(0, 0, new Date("2026-03-21T00:07:00Z"))).toBeLessThan(-85);
    expect(greatCircleKm(0, 0, 0, 1)).toBeCloseTo(111.2, 0);
  });
});

describe("CelesTrak elements", () => {
  it("keeps only ORYN's imaging satellites and rejects malformed payloads", () => {
    const byId = normalizeOmm([OMM])!;
    expect([...byId.keys()].sort()).toEqual([39084, 42063]); // Terra ignored
    expect(normalizeOmm([{ not: "an array" }])).toBeNull();
    expect(normalizeOmm([[{ NORAD_CAT_ID: 42063, OBJECT_NAME: "X", EPOCH: "not a date" }]])).toBeNull();
  });

  it("downloads at most once per 2 hours, then serves stale elements after a refused refresh", async () => {
    let t = Date.parse("2026-10-16T21:00:00Z");
    let refuse = false;
    const fetchImpl = vi.fn<FetchLike>(async () => (refuse ? new Response("blocked", { status: 403 }) : json(OMM)));
    const opts = { ...open, fetchImpl, now: () => t };
    const a = await satelliteTracks(new Date(t), { ...opts, halfWindowMinutes: 2 });
    await satelliteTracks(new Date(t), { ...opts, halfWindowMinutes: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // two queries, one refresh
    expect(a.feed.state).toBe("stale"); // six of eight satellites have no elements in this fixture
    expect(a.feed.message).toMatch(/No current elements for Sentinel-2A/);
    const s2b = a.satellites.find((s) => s.noradId === 42063)!;
    expect(s2b.track!.samples).toHaveLength(9); // ±2 min every 30 s
    t += 2 * 3_600_000 + 1;
    refuse = true;
    const b = await satelliteTracks(new Date(t), { ...opts, halfWindowMinutes: 1 });
    expect(b.feed.state).toBe("stale");
    expect(b.feed.message).toMatch(/blocks clients that download too often/);
    expect(b.satellites.find((s) => s.noradId === 42063)!.track).not.toBeNull();
    const calls = fetchImpl.mock.calls.length;
    t += 60_000;
    await satelliteTracks(new Date(t), opts);
    expect(fetchImpl.mock.calls.length).toBe(calls); // waits 30 min before trying again
  });

  it("is off in production until verified, and lists daylight descending optical passes only", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => json(OMM));
    const off = await satelliteTracks(new Date(), { production: true, verified: [], fetchImpl });
    expect(off.feed.state).toBe("disabled");
    expect(fetchImpl).not.toHaveBeenCalled();
    const r = await satelliteOverpasses({ lon: -80.73, lat: 35.306 }, new Date("2026-10-14T00:00:00Z"), 1, { ...open, fetchImpl, now: () => Date.parse("2026-10-16T21:00:00Z") });
    const s2b = r.passes.filter((p) => p.name === "Sentinel-2B");
    expect(s2b).toHaveLength(1);
    expect(s2b[0]).toMatchObject({ direction: "descending" });
    expect(r.passes.every((p) => p.sunElevationDeg >= 5)).toBe(true);
  });
});

describe("Caltrans camera registry", () => {
  it("keeps in-service cameras with Caltrans-hosted media only", () => {
    const rows = normalizeCaltrans(7, CALTRANS)!;
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ id: "caltrans-cctv:7:1", provider: "caltrans-cctv", district: "D7", video: { hls: expect.stringMatching(/^https:\/\/wzmedia\.dot\.ca\.gov\/.+\.m3u8$/) } });
    expect(rows[0]!.still!.url).toMatch(/^https:\/\/cwwp2\.dot\.ca\.gov\/data\/d7\/cctv\/image\//);
    const tampered = structuredClone(CALTRANS);
    (tampered.data[0]!.cctv.imageData as { streamingVideoURL: string }).streamingVideoURL = "https://evil.example/x.m3u8";
    expect(normalizeCaltrans(7, tampered)![0]!.video).toBeNull();
    expect(normalizeCaltrans(7, { nope: true })).toBeNull();
  });

  it("reports districts that failed and samples evenly over the limit", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => (url.includes("/d7/") ? json(CALTRANS) : url.includes("/d4/") ? new Response("down", { status: 503 }) : json({ data: [] })));
    const r = await cameras([-125, 32, -114, 42.1], { ...open, fetchImpl });
    expect(r.total).toBe(2);
    expect(r.feed.state).toBe("partial");
    expect(r.feed.message).toMatch(/D4/);
    expect(r.analytics.status).toBe("not_enabled");
    const off = await cameras([-125, 32, -114, 42.1], { production: true, verified: [], fetchImpl });
    expect(off.feed.state).toBe("disabled");
  });

  it("searches the whole registry by name, route, or place, regardless of the view", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) => (url.includes("/d7/") ? json(CALTRANS) : json({ data: [] })));
    const r = await cameras([0, 0, 1, 1], { ...open, fetchImpl, q: "avenue 26" });
    expect(r.cameras.map((c) => c.name)).toEqual([expect.stringMatching(/Avenue 26/)]);
    expect((await cameras([0, 0, 1, 1], { ...open, fetchImpl })).total).toBe(0);
  });

  it("tells an offline stream from an online one, server-side", async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url, init) => {
      if (init?.method === "HEAD") return new Response(null, { status: url.includes("CCTV-196") ? 200 : 404 });
      return url.includes("/d7/") ? json(CALTRANS) : json({ data: [] });
    });
    const ids = normalizeCaltrans(7, CALTRANS)!.map((c) => c.id);
    const first = await streamHealth(ids[0]!, { ...open, fetchImpl });
    expect(first).toMatchObject({ status: "online", httpStatus: 200 });
    const second = await streamHealth(ids[1]!, { ...open, fetchImpl });
    expect(second).toMatchObject({ status: "offline", httpStatus: 404 });
    expect(second!.message).toMatch(/offline right now \(HTTP 404\)/);
    expect(await streamHealth("caltrans-cctv:7:does-not-exist", { ...open, fetchImpl })).toBeNull();
  });
});
