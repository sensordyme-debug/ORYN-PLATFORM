import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BASEMAPS, getMapLayer, MAP_LAYERS, OVERLAYS } from "@/lib/map-layers";
import { resetHostLimiter } from "@/server/providers/http";
import { checkProviderHealth, getProviderDescriptor, providerAvailability, PROVIDERS } from "@/server/providers/registry";
import { fixtureJson, fixtureText, jsonResponse, mockFetch, textResponse } from "./_mock-fetch";

beforeAll(() => {
  vi.stubEnv("LOG_LEVEL", "error");
});
beforeEach(() => resetHostLimiter());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("LOG_LEVEL", "error");
});

const EXPECTED_IDS = [
  "earth-search",
  "planetary-computer",
  "copernicus-dataspace",
  "nasa-cmr",
  "nws",
  "open-meteo",
  "gdelt",
  "tigerweb",
  "overpass",
  "census-geocoder",
  "usgs-national-map",
  "fema-nfhl",
  "openfreemap",
];

describe("provider descriptors", () => {
  it("lists every provider once with licensing, credentials, and namespaced products", () => {
    expect(PROVIDERS.map((p) => p.id).sort()).toEqual([...EXPECTED_IDS].sort());
    for (const p of PROVIDERS) {
      expect(p.licensing.summary.length, p.id).toBeGreaterThan(20);
      expect(p.licensing.redistribution.length, p.id).toBeGreaterThan(5);
      expect(["allowed", "restricted", "requires_license"]).toContain(p.licensing.commercialUse);
      expect(p.delivery).toBe("polling");
      expect(p.products.length, p.id).toBeGreaterThan(0);
      for (const prod of p.products) expect(prod.id.startsWith(`${p.id}:`), prod.id).toBe(true);
    }
    const productIds = PROVIDERS.flatMap((p) => p.products.map((x) => x.id));
    expect(new Set(productIds).size).toBe(productIds.length);
    expect(getProviderDescriptor("open-meteo")?.licensing.commercialUse).toBe("requires_license");
    expect(getProviderDescriptor("nope")).toBeNull();
  });
});

describe("providerAvailability", () => {
  it("reports missing credentials by env var name", () => {
    vi.stubEnv("EARTHDATA_TOKEN", "");
    vi.stubEnv("CDSE_CLIENT_ID", "");
    vi.stubEnv("CDSE_CLIENT_SECRET", "");
    const cmr = providerAvailability("nasa-cmr");
    expect(cmr.state === "unconfigured" && cmr.reason).toContain("EARTHDATA_TOKEN");
    const cdse = providerAvailability("copernicus-dataspace");
    expect(cdse.state === "unconfigured" && cdse.reason).toContain("CDSE_CLIENT_ID and CDSE_CLIENT_SECRET");
    vi.stubEnv("EARTHDATA_TOKEN", "t");
    expect(providerAvailability("nasa-cmr")).toEqual({ state: "available" });
  });

  it("applies the production gates for NWS identification and Open-Meteo licensing", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NWS_USER_AGENT", "");
    vi.stubEnv("OPEN_METEO_API_KEY", "");
    vi.stubEnv("OPEN_METEO_ALLOW_NONCOMMERCIAL", "");
    expect(providerAvailability("nws").state).toBe("unconfigured");
    const om = providerAvailability("open-meteo");
    expect(om.state).toBe("disabled");
    expect(om.state === "disabled" && om.reason).toContain("non-commercial");
    vi.stubEnv("OPEN_METEO_API_KEY", "key");
    vi.stubEnv("NWS_USER_AGENT", "(oryn.test, ops@oryn.test)");
    expect(providerAvailability("open-meteo")).toEqual({ state: "available" });
    expect(providerAvailability("nws")).toEqual({ state: "available" });
  });

  it("honours GDELT_ENABLED and rejects unknown ids", () => {
    vi.stubEnv("GDELT_ENABLED", "false");
    expect(providerAvailability("gdelt").state).toBe("disabled");
    expect(providerAvailability("earth-search")).toEqual({ state: "available" });
    expect(providerAvailability("nope").state).toBe("disabled");
  });
});

describe("checkProviderHealth", () => {
  it("probes a STAC collection", async () => {
    const f = mockFetch(() => jsonResponse({ id: "sentinel-2-l2a" }));
    const r = await checkProviderHealth("earth-search", undefined, { fetchImpl: f });
    expect(r.ok).toBe(true);
    expect(r.details).toMatchObject({ collection: "sentinel-2-l2a", availability: "available" });
    expect(f.calls[0]!.url).toBe("https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a");
  });

  it("still probes public catalog search when asset access is unconfigured", async () => {
    vi.stubEnv("EARTHDATA_TOKEN", "");
    const f = mockFetch(() => jsonResponse({ id: "HLSS30_2.0" }));
    const r = await checkProviderHealth("nasa-cmr", undefined, { fetchImpl: f });
    expect(r.ok).toBe(true);
    expect(r.details?.availability).toBe("unconfigured");
  });

  it("reads the TIGERweb layer vintage", async () => {
    const f = mockFetch(() => jsonResponse(fixtureJson("tigerweb-layer-4.json")));
    const r = await checkProviderHealth("tigerweb", undefined, { fetchImpl: f });
    expect(r).toMatchObject({ ok: true, details: { vintage: "January 1, 2026" } });
  });

  it("skips disabled providers without a request", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPEN_METEO_API_KEY", "");
    vi.stubEnv("OPEN_METEO_ALLOW_NONCOMMERCIAL", "");
    const f = mockFetch(() => jsonResponse({}));
    const r = await checkProviderHealth("open-meteo", undefined, { fetchImpl: f });
    expect(r).toMatchObject({ ok: false, latencyMs: 0, details: { skipped: true, availability: "disabled" } });
    expect(f.calls).toHaveLength(0);
  });

  it("reports a GDELT rate-limit notice as unhealthy", async () => {
    vi.stubEnv("GDELT_ENABLED", "true");
    const f = mockFetch(() => textResponse(fixtureText("gdelt-rate-limit.txt")));
    const r = await checkProviderHealth("gdelt", undefined, { fetchImpl: f });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/rate limit/i);
  });

  it("checks tile services by content type and never throws on failure", async () => {
    const png = mockFetch(() => new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "content-type": "image/png" } }));
    expect((await checkProviderHealth("usgs-national-map", undefined, { fetchImpl: png })).ok).toBe(true);
    expect(png.calls[0]!.url).toBe("https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/0/0/0");
    const down = mockFetch(() => textResponse("bad gateway", 502));
    const r = await checkProviderHealth("overpass", undefined, { fetchImpl: down });
    expect(r.ok).toBe(false);
    expect(r.details).toMatchObject({ code: "unavailable", status: 502 });
  });
});

describe("map layer catalog", () => {
  it("is isomorphic (no server imports)", () => {
    const src = readFileSync(path.resolve(__dirname, "../../../src/lib/map-layers.ts"), "utf8");
    expect(src).not.toMatch(/from\s+["']@\/server/);
    expect(src).not.toMatch(/\bimport\b/);
  });

  it("describes every layer with attribution, licence, source, and a valid template", () => {
    const ids = MAP_LAYERS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(BASEMAPS.map((l) => l.id)).toEqual(["usgs-imagery", "usgs-topo", "openfreemap-liberty"]);
    expect(OVERLAYS.map((l) => l.id)).toEqual(["usgs-shaded-relief", "usgs-hydro", "fema-nfhl-flood-zones"]);
    for (const l of MAP_LAYERS) {
      expect(l.attribution).not.toMatch(/<[^>]+>/);
      expect(l.license.length).toBeGreaterThan(10);
      expect(l.sourceUrl).toMatch(/^https:\/\//);
      expect(getProviderDescriptor(l.providerId), l.id).not.toBeNull();
      if (l.kind === "raster") expect(l.tileUrl).toMatch(/\{z\}\/\{y\}\/\{x\}|\{bbox-epsg-3857\}/);
      else expect(l.styleUrl).toMatch(/^https:\/\//);
    }
    const fema = getMapLayer("fema-nfhl-flood-zones")!;
    expect(fema.notes).toMatch(/not observed/);
    expect(fema.minZoom).toBe(15);
    expect(getMapLayer("usgs-imagery")!.maxNativeZoom).toBe(16);
  });
});
