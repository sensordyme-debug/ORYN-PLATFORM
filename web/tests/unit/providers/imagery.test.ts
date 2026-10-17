import { beforeAll, describe, expect, it, vi } from "vitest";
import { ANALYTICS } from "@/server/analytics/registry";
import { ProviderError, resetHostLimiter } from "@/server/providers/http";
import { createCopernicusProvider } from "@/server/providers/imagery/copernicus";
import { createEarthSearchProvider } from "@/server/providers/imagery/earth-search";
import { getImageryProduct, listImageryProducts, productsForAnalytic } from "@/server/providers/imagery/index";
import { createNasaCmrProvider } from "@/server/providers/imagery/nasa-cmr";
import { createPlanetaryComputerProvider, createSasTokenCache, signBlobUrl } from "@/server/providers/imagery/planetary-computer";
import type { StacItemCollection } from "@/server/providers/stac";
import { fixtureJson, jsonResponse, mockFetch } from "./_mock-fetch";

beforeAll(() => {
  vi.stubEnv("LOG_LEVEL", "error");
  resetHostLimiter();
});

const AOI = { type: "Point" as const, coordinates: [-77.5358, 35.8968] as [number, number] };
const SAS = fixtureJson<{ "msft:expiry": string; token: string }>("pc-sas-token.json");

describe("Planetary Computer SAS signing", () => {
  it("appends the collection token to blob URLs and leaves other hosts alone", () => {
    expect(signBlobUrl("https://acct.blob.core.windows.net/c/a.tif", "st=1&sig=x")).toBe("https://acct.blob.core.windows.net/c/a.tif?st=1&sig=x");
    expect(signBlobUrl("https://acct.blob.core.windows.net/c/a.tif?v=1", "st=1")).toBe("https://acct.blob.core.windows.net/c/a.tif?v=1&st=1");
    expect(signBlobUrl("https://example.com/a.tif", "st=1")).toBe("https://example.com/a.tif");
  });

  it("caches a token per collection until five minutes before expiry", async () => {
    const expiry = Date.parse(SAS["msft:expiry"]);
    let now = expiry - 60 * 60 * 1000;
    const f = mockFetch(() => jsonResponse(SAS));
    const cache = createSasTokenCache({ sasUrl: "https://pc.example/api/sas/v1", fetchImpl: f, now: () => now, subscriptionKey: "" });
    expect(await cache.token("sentinel-1-rtc")).toBe(SAS.token);
    expect(await cache.token("sentinel-1-rtc")).toBe(SAS.token);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://pc.example/api/sas/v1/token/sentinel-1-rtc");

    await cache.token("landsat-c2-l2");
    expect(f.calls).toHaveLength(2);

    now = expiry - 4 * 60 * 1000; // inside the 5-minute margin → refresh
    await cache.token("sentinel-1-rtc");
    expect(f.calls).toHaveLength(3);
  });

  it("shares one in-flight token request between concurrent callers", async () => {
    const f = mockFetch(() => jsonResponse(SAS));
    const cache = createSasTokenCache({ sasUrl: "https://pc.example/sas", fetchImpl: f, now: () => 0, subscriptionKey: "" });
    await Promise.all([cache.token("esa-worldcover"), cache.token("esa-worldcover"), cache.token("esa-worldcover")]);
    expect(f.calls).toHaveLength(1);
  });

  it("sends the subscription key header when configured", async () => {
    const f = mockFetch(() => jsonResponse(SAS));
    const cache = createSasTokenCache({ sasUrl: "https://pc.example/sas", fetchImpl: f, now: () => 0, subscriptionKey: "k-123" });
    await cache.token("io-lulc-annual-v02");
    expect((f.calls[0]!.init!.headers as Record<string, string>)["ocp-apim-subscription-key"]).toBe("k-123");
  });

  it("rejects a token response without expiry", async () => {
    const f = mockFetch(() => jsonResponse({ token: "st=1" }));
    const cache = createSasTokenCache({ sasUrl: "https://pc.example/sas", fetchImpl: f, now: () => 0, subscriptionKey: "" });
    await expect(cache.token("x")).rejects.toMatchObject({ code: "bad_response" });
  });

  it("resolveAccess signs the asset href for the item's collection", async () => {
    const page = fixtureJson<StacItemCollection>("pc-sentinel-1-rtc.json");
    page.links = [];
    const f = mockFetch((url) => (url.includes("/sas/") ? jsonResponse(SAS) : jsonResponse(page)));
    const pc = createPlanetaryComputerProvider({
      fetchImpl: f,
      baseUrl: "https://planetarycomputer.microsoft.com/api/stac/v1",
      sasUrl: "https://planetarycomputer.microsoft.com/api/sas/v1",
      subscriptionKey: "",
      now: () => Date.parse(SAS["msft:expiry"]) - 3_600_000,
    });
    const [asset] = await pc.search({ productId: "planetary-computer:sentinel-1-rtc", intersects: AOI, start: new Date("2026-10-01"), end: new Date("2026-10-15") });
    const access = await pc.resolveAccess(asset!, "vv");
    expect(access.url.startsWith(`${asset!.assets.vv!.href}?st=`)).toBe(true);
    expect(access.url).toContain("sig=REDACTED");
    expect(f.calls.filter((c) => c.url.endsWith("/token/sentinel-1-rtc"))).toHaveLength(1);
    await expect(pc.resolveAccess(asset!, "red")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("credential gates", () => {
  const hlsAsset = { collection: "HLSS30_2.0", assets: { red: { href: "https://data.lpdaac.earthdatacloud.nasa.gov/lp-prod-protected/x.B04.tif" } } };

  it("NASA CMR: no token → unconfigured availability naming EARTHDATA_TOKEN and resolveAccess throws", async () => {
    const cmr = createNasaCmrProvider({ token: undefined, fetchImpl: mockFetch(() => jsonResponse({})) });
    const a = cmr.availability();
    expect(a.state).toBe("unconfigured");
    expect(a.state !== "available" && a.reason).toContain("EARTHDATA_TOKEN");
    const err = await cmr.resolveAccess(hlsAsset, "red").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("unconfigured");
    expect((err as ProviderError).retryable).toBe(false);
  });

  it("NASA CMR: token → bearer header on the asset URL", async () => {
    const cmr = createNasaCmrProvider({ token: "edl-token" });
    expect(cmr.availability()).toEqual({ state: "available" });
    expect(await cmr.resolveAccess(hlsAsset, "red")).toEqual({ url: hlsAsset.assets.red.href, headers: { Authorization: "Bearer edl-token" } });
  });

  it("NASA CMR: search is public and works without a token", async () => {
    const page = fixtureJson<StacItemCollection>("cmr-hls-search.json");
    page.links = [];
    const f = mockFetch(() => jsonResponse(page));
    const cmr = createNasaCmrProvider({ token: undefined, fetchImpl: f, baseUrl: "https://cmr.earthdata.nasa.gov/stac/LPCLOUD" });
    const results = await cmr.search({ productId: "nasa-cmr:hls", intersects: AOI, start: new Date("2026-09-15"), end: new Date("2026-10-15") });
    expect(results.map((r) => r.collection).sort()).toEqual(["HLSL30_2.0", "HLSS30_2.0"]);
    expect((f.calls[0]!.init!.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("Copernicus: without client credentials availability is unconfigured and access throws", async () => {
    const cdse = createCopernicusProvider({ clientId: undefined, clientSecret: undefined });
    const a = cdse.availability();
    expect(a.state).toBe("unconfigured");
    expect(a.state !== "available" && a.reason).toMatch(/CDSE_CLIENT_ID and CDSE_CLIENT_SECRET/);
    await expect(cdse.resolveAccess({ collection: "sentinel-2-l2a", assets: { red: { href: "https://download.dataspace.copernicus.eu/x" } } }, "red")).rejects.toMatchObject({
      code: "unconfigured",
    });
  });

  it("Copernicus: with client credentials a cached client-credentials token is used", async () => {
    const f = mockFetch(() => jsonResponse({ access_token: "tok", expires_in: 600 }));
    const cdse = createCopernicusProvider({ clientId: "id", clientSecret: "secret", fetchImpl: f, tokenUrl: "https://idp.example/token", now: () => 0 });
    const asset = { collection: "sentinel-2-l2a", assets: { red: { href: "https://download.dataspace.copernicus.eu/x" } } };
    expect(await cdse.resolveAccess(asset, "red")).toEqual({ url: asset.assets.red.href, headers: { Authorization: "Bearer tok" } });
    await cdse.resolveAccess(asset, "red");
    expect(f.calls).toHaveLength(1);
    expect(String(f.calls[0]!.init!.body)).toContain("grant_type=client_credentials");
  });

  it("Earth Search: public COG URLs are returned unchanged", async () => {
    const es = createEarthSearchProvider();
    const href = "https://sentinel-cogs.s3.us-west-2.amazonaws.com/x/B04.tif";
    expect(await es.resolveAccess({ collection: "sentinel-2-l2a", assets: { red: { href } } }, "red")).toEqual({ url: href });
    await expect(es.search({ productId: "earth-search:nope", intersects: AOI, start: new Date(0), end: new Date() })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("imagery registry", () => {
  it("resolves every documented product id", () => {
    for (const id of [
      "earth-search:sentinel-2-l2a",
      "planetary-computer:sentinel-1-rtc",
      "planetary-computer:landsat-c2-l2",
      "planetary-computer:esa-worldcover",
      "planetary-computer:io-lulc-annual-v02",
      "copernicus-dataspace:sentinel-2-l2a",
      "nasa-cmr:hls",
    ]) {
      const r = getImageryProduct(id);
      expect(r, id).not.toBeNull();
      expect(r!.product.id).toBe(id);
      expect(id.startsWith(`${r!.provider.descriptor.id}:`)).toBe(true);
    }
    expect(getImageryProduct("nope:x")).toBeNull();
    expect(getImageryProduct("earth-search")).toBeNull();
    expect(getImageryProduct("copernicus-dataspace:sentinel-2-l2a")!.product.capabilities).toEqual({ search: true, assetAccess: false });
  });

  it("product analytics match the analytics registry input contracts exactly", () => {
    const fromRegistry = new Map<string, Set<string>>();
    for (const a of Object.values(ANALYTICS)) {
      const products = (a.inputContract as { products?: string[] }).products ?? [];
      for (const p of products) fromRegistry.set(p, (fromRegistry.get(p) ?? new Set()).add(a.id));
    }
    for (const { product } of listImageryProducts()) {
      expect([...product.analytics].sort(), product.id).toEqual([...(fromRegistry.get(product.id) ?? [])].sort());
    }
    for (const id of fromRegistry.keys()) expect(getImageryProduct(id), id).not.toBeNull();
    expect(productsForAnalytic("ndvi").map((p) => p.product.id).sort()).toEqual(["earth-search:sentinel-2-l2a", "planetary-computer:landsat-c2-l2"]);
  });
});
