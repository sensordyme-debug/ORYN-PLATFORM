import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allLayersFromEnv, distanceKm, ENGINE_API_PREFIXES, ENGINE_DEV_API_PREFIXES, engineApiPrefixes, transitFeedsInView, type EngineTransitFeed } from "@/lib/intel/engine";

describe("transit coverage for the camera", () => {
  const feeds: EngineTransitFeed[] = [
    { id: "mbta", name: "MBTA", region: "Boston, MA", center: { lat: 42.3601, lon: -71.0589 }, loadRadiusKm: 70 },
    { id: "hsl-helsinki", name: "HSL", region: "Helsinki, Finland", center: { lat: 60.1699, lon: 24.9384 }, loadRadiusKm: 60 },
  ];
  it("measures great-circle distance", () => {
    expect(distanceKm({ lat: 42.3601, lon: -71.0589 }, { lat: 40.7128, lon: -74.006 })).toBeCloseTo(306, -1);
  });
  it("lists the feeds within their load radius plus slack, below the activation altitude", () => {
    expect(transitFeedsInView(feeds, { lat: 42.36, lon: -71.06, alt: 50_000 }).map((f) => f.id)).toEqual(["mbta"]);
    // Worcester is about 64 km from Boston: inside 70 km.
    expect(transitFeedsInView(feeds, { lat: 42.2626, lon: -71.8023, alt: 50_000 }).map((f) => f.id)).toEqual(["mbta"]);
    expect(transitFeedsInView(feeds, { lat: 37.78, lon: -122.42, alt: 12_000 })).toEqual([]);
    expect(transitFeedsInView(feeds, { lat: 42.36, lon: -71.06, alt: 4_000_000 })).toEqual([]);
  });
});

const proxy = readFileSync(new URL("../../src/proxy.ts", import.meta.url), "utf8");

describe("engine routes forwarded by ORYN", () => {
  it("are the licence-cleared routes by default, and every layer's under ORYN_ALL_LAYERS", () => {
    expect(engineApiPrefixes(false)).toEqual(ENGINE_API_PREFIXES);
    expect(engineApiPrefixes(true)).toEqual([...ENGINE_API_PREFIXES, ...ENGINE_DEV_API_PREFIXES]);
    expect(engineApiPrefixes(true)).toContain("celestrak");
    expect(engineApiPrefixes(false)).not.toContain("celestrak");
  });

  it("never include routes that write engine configuration or call paid services", () => {
    for (const route of ["setup", "openai", "realtime", "google", "tomtom"]) expect(engineApiPrefixes(true)).not.toContain(route);
  });

  it("never collide with ORYN's own API routes", () => {
    for (const route of ["auth", "contact", "cron", "health", "v1"]) expect(engineApiPrefixes(true)).not.toContain(route);
  });

  it("are all in the proxy's static matcher, so each one is session-gated", () => {
    for (const route of engineApiPrefixes(true)) expect(proxy).toMatch(new RegExp(`/api/:engine\\([^)]*\\b${route}\\b[^)]*\\)`));
  });

  it("switch on only outside production", () => {
    expect(allLayersFromEnv({ ORYN_ALL_LAYERS: "1", NODE_ENV: "development" })).toBe(true);
    expect(allLayersFromEnv({ ORYN_ALL_LAYERS: "true", NODE_ENV: "development" })).toBe(true);
    expect(allLayersFromEnv({ ORYN_ALL_LAYERS: "1", NODE_ENV: "production" })).toBe(false);
    expect(allLayersFromEnv({ ORYN_ALL_LAYERS: "0", NODE_ENV: "development" })).toBe(false);
    expect(allLayersFromEnv({ NODE_ENV: "development" })).toBe(false);
  });
});
