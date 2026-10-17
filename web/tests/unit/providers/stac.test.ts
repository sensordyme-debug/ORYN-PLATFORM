import { beforeAll, describe, expect, it, vi } from "vitest";
import { CDSE_S2_L2A } from "@/server/providers/imagery/copernicus";
import { EARTH_SEARCH_S2_L2A } from "@/server/providers/imagery/earth-search";
import { HLS_L30, HLS_S30 } from "@/server/providers/imagery/nasa-cmr";
import { PC_COLLECTIONS } from "@/server/providers/imagery/planetary-computer";
import { resetHostLimiter } from "@/server/providers/http";
import {
  datetimeInterval,
  parseEpsg,
  searchStacProduct,
  stacItemToAsset,
  stacSearch,
  type StacCollectionConfig,
  type StacItem,
  type StacItemCollection,
} from "@/server/providers/stac";
import { bodyOf, fixtureJson, jsonResponse, mockFetch } from "./_mock-fetch";

beforeAll(() => {
  vi.stubEnv("LOG_LEVEL", "error");
  resetHostLimiter();
});

const AOI = { type: "Point" as const, coordinates: [-77.5358, 35.8968] as [number, number] };

function firstItem(fixture: string): StacItem {
  return fixtureJson<StacItemCollection>(fixture).features![0]!;
}

function map(fixture: string, config: StacCollectionConfig, providerId = "test", index = 0) {
  const item = fixtureJson<StacItemCollection>(fixture).features![index]!;
  const asset = stacItemToAsset(item, { providerId, config, baseUrl: "https://stac.example/v1" });
  expect(asset).not.toBeNull();
  return asset!;
}

describe("Earth Search Sentinel-2 L2A mapping", () => {
  const a = map("earth-search-search.json", EARTH_SEARCH_S2_L2A, "earth-search");

  it("maps identity, time, footprint, and grid", () => {
    expect(a.externalId).toBe("S2A_18STE_20261008_0_L2A");
    expect(a.collection).toBe("sentinel-2-l2a");
    expect(a.kind).toBe("optical");
    expect(a.platform).toBe("sentinel-2a");
    expect(a.instruments).toEqual(["msi"]);
    expect(a.acquiredAt.toISOString()).toBe("2026-10-08T16:03:37.818Z");
    expect(a.acquiredEndAt).toBeNull();
    expect(a.providerPublishedAt?.toISOString()).toBe("2026-10-09T00:12:00.283Z");
    expect(a.footprint.type).toBe("Polygon");
    expect(a.cloudCover).toBeCloseTo(30.463365);
    expect(a.epsg).toBe(32618);
    expect(a.gridCode).toBe("MGRS-18STE");
    expect(a.processingLevel).toBe("L2A");
    expect(a.processingBaseline).toBe("05.13");
    expect(a.gsdM).toBe(10);
    expect(a.stacUrl).toBe("https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/S2A_18STE_20261008_0_L2A");
  });

  it("maps canonical asset keys, ignores s3:// jp2 duplicates and non-analytic assets", () => {
    expect(Object.keys(a.assets).sort()).toEqual(["blue", "green", "nir", "nir08", "red", "scl", "swir16", "swir22", "visual"]);
    for (const f of Object.values(a.assets)) expect(f.href).toMatch(/^https:\/\/sentinel-cogs\.s3\.us-west-2\.amazonaws\.com\//);
    expect(a.assets.red!.href).toMatch(/\/B04\.tif$/);
    expect(a.assets.nir!.href).toMatch(/\/B08\.tif$/);
    expect(a.assets.nir08!.href).toMatch(/\/B8A\.tif$/);
    expect(a.assets.scl!.href).toMatch(/\/SCL\.tif$/);
  });

  it("keeps raster:bands exactly as published (scale, offset, nodata) with projection", () => {
    expect(a.assets.red).toMatchObject({
      bands: [{ scale: 0.0001, offset: -0.1, nodata: 0, dataType: "uint16" }],
      gsd: 10,
      projShape: [10980, 10980],
      projTransform: [10, 0, 199980, 0, -10, 4000020],
      epsg: 32618,
    });
    expect(a.assets.scl).toMatchObject({ gsd: 20, projShape: [5490, 5490], bands: [{ nodata: 0, dataType: "uint8" }] });
    expect(a.assets.scl!.bands![0]!.scale).toBeUndefined();
    expect(a.assets.visual!.bands).toHaveLength(3);
  });

  it("retains earthsearch:boa_offset_applied verbatim for the raster pipeline", () => {
    expect(a.properties["earthsearch:boa_offset_applied"]).toBe(true);
    expect(a.properties["s2:processing_baseline"]).toBe("05.13");
    // Not rewritten: the published offset stays; the pipeline overrides it using the flag.
    expect(a.assets.red!.bands![0]!.offset).toBe(-0.1);
  });

  it("records licence, licence URL, and year-stamped attribution", () => {
    expect(a.license).toBe("Copernicus Sentinel data terms (free, full and open)");
    expect(a.licenseUrl).toBe("https://sentinel.esa.int/documents/247904/690755/Sentinel_Data_Legal_Notice");
    expect(a.attribution).toBe("Contains modified Copernicus Sentinel data 2026");
  });

  it("drops bulky/private properties but keeps scalar provenance", () => {
    expect(a.properties["s2:product_uri"]).toBe("S2A_MSIL2A_20261008T155701_N0513_R054_T18STE_20261008T222459.SAFE");
    expect(a.properties["processing:software"]).toBeUndefined();
    expect(a.properties["proj:centroid"]).toBeUndefined();
  });
});

describe("Planetary Computer mappings", () => {
  it("Sentinel-1 RTC: vv/vh float32 linear with nodata, epsg and 3×3 transform from item, relative-orbit grid", () => {
    const a = map("pc-sentinel-1-rtc.json", PC_COLLECTIONS["sentinel-1-rtc"], "planetary-computer");
    expect(a.kind).toBe("sar");
    expect(Object.keys(a.assets).sort()).toEqual(["vh", "vv"]);
    expect(a.assets.vv).toMatchObject({
      bands: [{ nodata: -32768, dataType: "float32" }],
      gsd: 10,
      epsg: 32617,
      projShape: [21734, 28788],
      projTransform: [10, 0, 563770, 0, -10, 4047790],
    });
    expect(a.assets.vv!.href).toMatch(/^https:\/\/sentinel1euwestrtc\.blob\.core\.windows\.net\//);
    expect(a.epsg).toBe(32617);
    expect(a.gridCode).toBe("S1-RELORB-077");
    expect(a.acquiredAt.toISOString()).toBe("2026-10-14T23:13:54.728Z");
    expect(a.acquiredEndAt?.toISOString()).toBe("2026-10-14T23:14:07.228Z");
    expect(a.cloudCover).toBeNull();
    expect(a.license).toBe("CC-BY-4.0");
    expect(a.licenseUrl).toBe("https://creativecommons.org/licenses/by/4.0/");
    expect(a.attribution).toContain("Contains modified Copernicus Sentinel data 2026");
  });

  it("Landsat C2 L2: scale/offset per band, WRS-2 grid, item-level gsd and projection", () => {
    const a = map("pc-landsat-c2-l2.json", PC_COLLECTIONS["landsat-c2-l2"], "planetary-computer");
    expect(Object.keys(a.assets).sort()).toEqual(["blue", "green", "nir08", "qa_pixel", "red", "swir16", "swir22"]);
    expect(a.assets.red!.bands).toEqual([{ scale: 2.75e-5, offset: -0.2, nodata: 0, dataType: "uint16" }]);
    expect(a.assets.nir08!.href).toMatch(/_SR_B5\.TIF$/);
    expect(a.assets.qa_pixel!.href).toMatch(/_QA_PIXEL\.TIF$/);
    expect(a.assets.red!.projShape).toEqual([7961, 7841]);
    expect(a.assets.red!.epsg).toBe(32618);
    expect(a.gsdM).toBe(30);
    expect(a.gridCode).toBe("WRS2-015035");
    expect(a.processingLevel).toBe("L2SP");
    expect(a.platform).toBe("landsat-9");
    expect(a.license).toBe("Public domain (USGS)");
  });

  it("ESA WorldCover: interval time from start/end_datetime, EPSG:4326, grid:code, CC BY attribution", () => {
    const a = map("pc-esa-worldcover.json", PC_COLLECTIONS["esa-worldcover"], "planetary-computer");
    expect(a.kind).toBe("landcover");
    expect(a.acquiredAt.toISOString()).toBe("2021-01-01T00:00:00.000Z");
    expect(a.acquiredEndAt?.toISOString()).toBe("2021-12-31T23:59:59.000Z");
    expect(a.epsg).toBe(4326);
    expect(a.gridCode).toBe("ESAWORLDCOVER-N33W078");
    expect(Object.keys(a.assets)).toEqual(["map"]);
    expect(a.assets.map!.bands).toEqual([{ nodata: 0, dataType: "uint8" }]);
    expect(a.license).toBe("CC-BY-4.0");
    expect(a.attribution).toBe(
      "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium",
    );
  });

  it("IO LULC: provider key 'data' exposed as both 'data' and 'map'", () => {
    const a = map("pc-io-lulc-annual-v02.json", PC_COLLECTIONS["io-lulc-annual-v02"], "planetary-computer");
    expect(Object.keys(a.assets).sort()).toEqual(["data", "map"]);
    expect(a.assets.map!.href).toBe(a.assets.data!.href);
    expect(a.assets.data!.epsg).toBe(32618);
    expect(a.acquiredAt.toISOString()).toBe("2023-01-01T00:00:00.000Z");
    expect(a.acquiredEndAt?.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    expect(a.license).toBe("CC-BY-4.0");
  });

  it("Sentinel-2 L2A (PC): B-number keys map to canonical keys; no invented scale/offset", () => {
    const a = map("pc-sentinel-2-l2a.json", PC_COLLECTIONS["sentinel-2-l2a"], "planetary-computer");
    expect(a.assets.red!.href).toMatch(/_B04_10m\.tif$/);
    expect(a.assets.nir!.href).toMatch(/_B08_10m\.tif$/);
    expect(a.assets.scl!.href).toMatch(/_SCL_20m\.tif$/);
    expect(a.assets.red!.bands).toBeUndefined();
    expect(a.gridCode).toBe("MGRS-18STE");
    expect(a.processingBaseline).toBe("05.13");
  });
});

describe("Copernicus Data Space mapping (STAC 1.1 fields)", () => {
  const a = map("cdse-search.json", CDSE_S2_L2A, "copernicus-dataspace");

  it("reads EPSG from proj:code and asset-level raster:scale/offset", () => {
    expect(parseEpsg("EPSG:32618")).toBe(32618);
    expect(a.assets.red!.epsg).toBe(32618);
    expect(a.assets.red!.bands).toEqual([{ scale: 0.0001, offset: -0.1, nodata: 0, dataType: "uint16" }]);
    expect(a.assets.scl!.epsg).toBe(32618);
  });

  it("uses the HTTPS alternate for s3:// assets and keeps processing:version as baseline", () => {
    expect(a.assets.red!.href).toMatch(/^https:\/\/download\.dataspace\.copernicus\.eu\/odata\/v1\/Products\(/);
    expect(a.processingBaseline).toBe("05.13");
    expect(a.processingLevel).toBe("L2A");
    expect(a.gridCode).toBe("MGRS-18STE");
    expect(a.properties._private).toBeUndefined();
    expect(a.properties["storage:schemes"]).toBeUndefined();
    expect(a.properties["processing:version"]).toBe("05.13");
  });
});

describe("NASA CMR HLS mapping", () => {
  it("maps L30 bands to canonical keys and derives the MGRS tile from the granule id", () => {
    const a = map("cmr-hls-search.json", HLS_L30, "nasa-cmr", 0);
    expect(a.collection).toBe("HLSL30_2.0");
    expect(a.assets.red!.href).toMatch(/\.B04\.tif$/);
    expect(a.assets.nir!.href).toMatch(/\.B05\.tif$/);
    expect(a.assets.fmask!.href).toMatch(/\.Fmask\.tif$/);
    expect(a.assets.swir16!.href).toMatch(/\.B06\.tif$/);
    expect(Object.values(a.assets).every((f) => f.href.startsWith("https://data.lpdaac.earthdatacloud.nasa.gov/"))).toBe(true);
    expect(a.gridCode).toBe("MGRS-18STE");
    expect(a.epsg).toBeNull();
    expect(a.assets.red!.bands).toBeUndefined();
    expect(a.cloudCover).toBe(11);
    expect(a.processingLevel).toBe("L3");
  });

  it("maps S30 narrow NIR (B8A) to nir", () => {
    const a = map("cmr-hls-search.json", HLS_S30, "nasa-cmr", 1);
    expect(a.assets.nir!.href).toMatch(/\.B8A\.tif$/);
    expect(a.attribution).toContain("Copernicus Sentinel data 2026");
  });
});

describe("item validation", () => {
  it("skips items without a footprint or time", () => {
    const item = firstItem("earth-search-search.json");
    expect(stacItemToAsset({ ...item, geometry: null }, { providerId: "t", config: EARTH_SEARCH_S2_L2A })).toBeNull();
    expect(stacItemToAsset({ ...item, properties: { ...item.properties, datetime: null } }, { providerId: "t", config: EARTH_SEARCH_S2_L2A })).toBeNull();
  });

  it("validates datetime intervals", () => {
    expect(datetimeInterval(new Date("2026-09-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"))).toBe("2026-09-01T00:00:00.000Z/2026-10-01T00:00:00.000Z");
    expect(() => datetimeInterval(new Date("2026-10-01"), new Date("2026-09-01"))).toThrow(RangeError);
  });
});

describe("stacSearch pagination", () => {
  const client = (fetchImpl: ReturnType<typeof mockFetch>, baseUrl = "https://earth-search.aws.element84.com/v1") => ({
    providerId: "test",
    baseUrl,
    fetchImpl,
    retries: 0,
  });

  it("follows POST next links with their body and stops when there is no next link", async () => {
    const page1 = fixtureJson<StacItemCollection>("earth-search-search.json");
    const page2: StacItemCollection = {
      features: page1.features!.map((f) => ({ ...f, id: `${f.id}-p2` })),
      links: [],
    };
    const f = mockFetch((_u, _i, n) => jsonResponse(n === 0 ? page1 : page2));
    const r = await stacSearch(client(f), { collections: ["sentinel-2-l2a"], intersects: AOI, datetime: "2026-09-01T00:00:00Z/2026-10-15T00:00:00Z" });
    expect(r.items).toHaveLength(4);
    expect(r.pages).toBe(2);
    expect(r.truncated).toBe(false);
    expect(f.calls[0]!.url).toBe("https://earth-search.aws.element84.com/v1/search");
    expect(f.calls[1]!.init!.method).toBe("POST");
    expect(bodyOf(f.calls[1])).toMatchObject({ next: "2026-10-06T16:03:26.851000Z", collections: ["sentinel-2-l2a"] });
  });

  it("follows GET next links (CMR) and stops on an empty page", async () => {
    const page1 = fixtureJson<StacItemCollection>("cmr-hls-search.json");
    const next = page1.links!.find((l) => l.rel === "next")!.href;
    const f = mockFetch((_u, _i, n) => jsonResponse(n === 0 ? page1 : { type: "FeatureCollection", features: [], links: [] }));
    const r = await stacSearch(client(f, "https://cmr.earthdata.nasa.gov/stac/LPCLOUD"), {
      collections: ["HLSS30_2.0", "HLSL30_2.0"],
      intersects: AOI,
      datetime: "2026-09-15T00:00:00Z/2026-10-15T00:00:00Z",
    });
    expect(r.items).toHaveLength(2);
    expect(f.calls[1]!.init!.method).toBe("GET");
    expect(f.calls[1]!.url).toBe(next);
  });

  it("stops at the page cap and reports truncation", async () => {
    let n = 0;
    const f = mockFetch(() => {
      n++;
      return jsonResponse({
        features: [{ ...firstItem("earth-search-search.json"), id: `item-${n}` }],
        links: [{ rel: "next", href: "https://earth-search.aws.element84.com/v1/search", method: "POST", body: { next: `token-${n}` } }],
      });
    });
    const r = await stacSearch(client(f), { collections: ["sentinel-2-l2a"], intersects: AOI, datetime: "x/y", maxPages: 3 });
    expect(r.pages).toBe(3);
    expect(r.items).toHaveLength(3);
    expect(r.truncated).toBe(true);
  });

  it("stops at the item cap", async () => {
    const page = fixtureJson<StacItemCollection>("earth-search-search.json");
    const f = mockFetch(() => jsonResponse(page));
    const r = await stacSearch(client(f), { collections: ["sentinel-2-l2a"], intersects: AOI, datetime: "x/y", maxItems: 1 });
    expect(r.items).toHaveLength(1);
    expect(r.truncated).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(bodyOf(f.calls[0])).toMatchObject({ limit: 1 });
  });

  it("stops when a next link repeats the same request", async () => {
    const f = mockFetch((_u, init) =>
      jsonResponse({
        features: [{ ...firstItem("earth-search-search.json"), id: "same" }],
        links: [{ rel: "next", href: "https://earth-search.aws.element84.com/v1/search", method: "POST", body: JSON.parse(String(init!.body)) }],
      }),
    );
    const r = await stacSearch(client(f), { collections: ["sentinel-2-l2a"], intersects: AOI, datetime: "x/y" });
    expect(f.calls).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });

  it("rejects a response without a features array", async () => {
    const f = mockFetch(() => jsonResponse({ code: "oops" }));
    await expect(stacSearch(client(f), { collections: ["x"], intersects: AOI, datetime: "x/y" })).rejects.toMatchObject({ code: "bad_response" });
  });
});

describe("searchStacProduct", () => {
  it("sends the cloud-cover query and sortby, filters client-side, and sorts newest first", async () => {
    const page = fixtureJson<StacItemCollection>("earth-search-search.json");
    page.links = [];
    const f = mockFetch(() => jsonResponse(page));
    const results = await searchStacProduct({ providerId: "earth-search", baseUrl: "https://earth-search.aws.element84.com/v1", fetchImpl: f }, [EARTH_SEARCH_S2_L2A], {
      productId: "earth-search:sentinel-2-l2a",
      intersects: AOI,
      start: new Date("2026-09-01T00:00:00Z"),
      end: new Date("2026-10-15T00:00:00Z"),
      maxCloudCover: 20,
    });
    expect(bodyOf(f.calls[0])).toMatchObject({
      query: { "eo:cloud_cover": { lte: 20 } },
      sortby: [{ field: "properties.datetime", direction: "desc" }],
      datetime: "2026-09-01T00:00:00.000Z/2026-10-15T00:00:00.000Z",
    });
    // The 30.5 % scene is removed client-side even if a server ignored the query.
    expect(results.map((r) => r.externalId)).toEqual(["S2C_18STE_20261006_0_L2A"]);
  });

  it("does not send a cloud query for collections without eo:cloud_cover", async () => {
    const page = fixtureJson<StacItemCollection>("pc-sentinel-1-rtc.json");
    page.links = [];
    const f = mockFetch(() => jsonResponse(page));
    const results = await searchStacProduct(
      { providerId: "planetary-computer", baseUrl: "https://planetarycomputer.microsoft.com/api/stac/v1", fetchImpl: f },
      [PC_COLLECTIONS["sentinel-1-rtc"]],
      { productId: "planetary-computer:sentinel-1-rtc", intersects: AOI, start: new Date("2026-10-01"), end: new Date("2026-10-15"), maxCloudCover: 10 },
    );
    expect(bodyOf(f.calls[0])).not.toHaveProperty("query");
    expect(results).toHaveLength(1);
  });
});
