import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BBox } from "@/lib/geo";
import { resetHostLimiter } from "@/server/providers/http";
import { buildOverpassQuery, elementToFeature, fetchOsmFeatures, OVERPASS_MAX_FEATURES, validateBbox } from "@/server/providers/reference/overpass";
import {
  clearTigerwebCache,
  getCountyBoundary,
  getPlaceBoundary,
  parseVintage,
  searchCounties,
  searchPlaces,
  sqlString,
  toMultiPolygon,
  validatePlaceName,
} from "@/server/providers/reference/tigerweb";
import { fixtureJson, jsonResponse, mockFetch } from "./_mock-fetch";

beforeAll(() => {
  vi.stubEnv("LOG_LEVEL", "error");
});
beforeEach(() => {
  resetHostLimiter();
  clearTigerwebCache();
});

const NOW = () => new Date("2026-10-15T20:00:00Z");

describe("TIGERweb", () => {
  function tigerFetch() {
    return mockFetch((url) => {
      const u = new URL(url);
      const where = u.searchParams.get("where") ?? "";
      if (u.pathname.endsWith("/MapServer/4") && u.searchParams.get("f") === "json") return jsonResponse(fixtureJson("tigerweb-layer-4.json"));
      if (u.pathname.endsWith("/MapServer/4/query") && where === "GEOID='3766700'") return jsonResponse(fixtureJson("tigerweb-place-geojson.json"));
      if (u.pathname.endsWith("/MapServer/4/query") && where.includes("'Tarboro'")) return jsonResponse(fixtureJson("tigerweb-place-search.json"));
      if (u.searchParams.get("f") === "geojson") return jsonResponse({ type: "FeatureCollection", features: [] });
      return jsonResponse({ features: [] });
    });
  }

  it("maps a place boundary to a MultiPolygon with provenance and vintage", async () => {
    const f = tigerFetch();
    const r = await getPlaceBoundary("3766700", { fetchImpl: f, now: NOW });
    expect(r.geometry.type).toBe("MultiPolygon");
    expect(r.geometry.coordinates).toHaveLength(3);
    for (const poly of r.geometry.coordinates) {
      const ring = poly[0]!;
      expect(ring[0]).toEqual(ring[ring.length - 1]);
    }
    expect(r.properties).toMatchObject({ NAME: "Tarboro town", GEOID: "3766700", STATE: "37", LSADC: "43", FUNCSTAT: "A", kind: "incorporated_place" });
    expect(r.provenance).toEqual({
      provider: "tigerweb",
      service_url: "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/4",
      layer: "Incorporated Places",
      layer_id: 4,
      vintage: "January 1, 2026",
      query: "GEOID='3766700'",
      retrieved_at: "2026-10-15T20:00:00.000Z",
      license: "Public domain (U.S. Census Bureau)",
    });
    const q = new URL(f.calls[0]!.url).searchParams;
    expect(q.get("outSR")).toBe("4326");
    expect(q.get("f")).toBe("geojson");
  });

  it("falls through to census designated places, then reports not_found", async () => {
    const f = tigerFetch();
    await expect(getPlaceBoundary("3799999", { fetchImpl: f, now: NOW })).rejects.toMatchObject({ code: "not_found" });
    expect(f.calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/4/query",
      "/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/5/query",
    ]);
  });

  it("searches places by exact name and state with a safe where clause", async () => {
    const f = tigerFetch();
    const places = await searchPlaces("Tarboro", "37", { fetchImpl: f });
    expect(places).toEqual([
      {
        kind: "incorporated_place",
        geoid: "3766700",
        name: "Tarboro town",
        basename: "Tarboro",
        stateFips: "37",
        countyFips: null,
        lsadCode: "43",
        funcStat: "A",
        areaLandM2: 29669088,
        areaWaterM2: 95092,
        position: [-77.5555414, 35.9042418],
      },
    ]);
    expect(new URL(f.calls[0]!.url).searchParams.get("where")).toBe("(UPPER(BASENAME)=UPPER('Tarboro') OR UPPER(NAME)=UPPER('Tarboro')) AND STATE='37'");
  });

  it("escapes quotes and rejects unsafe or malformed input before any request", async () => {
    expect(sqlString("Coeur d'Alene")).toBe("'Coeur d''Alene'");
    expect(validatePlaceName("  Coeur  d’Alene ")).toBe("Coeur d'Alene");
    const f = tigerFetch();
    await expect(searchPlaces("x' OR 1=1 --", undefined, { fetchImpl: f })).rejects.toThrow(RangeError);
    await expect(searchPlaces("Tar%", undefined, { fetchImpl: f })).rejects.toThrow(RangeError);
    await expect(searchPlaces("Tarboro", "NC", { fetchImpl: f })).rejects.toThrow(RangeError);
    await expect(searchCounties("Edgecombe", "3", { fetchImpl: f })).rejects.toThrow(RangeError);
    await expect(getPlaceBoundary("37667", { fetchImpl: f })).rejects.toThrow(RangeError);
    await expect(getCountyBoundary("37065'--", { fetchImpl: f })).rejects.toThrow(RangeError);
    expect(f.calls).toHaveLength(0);
  });

  it("turns an ArcGIS error body into bad_response", async () => {
    const f = mockFetch(() => jsonResponse(fixtureJson("tigerweb-error.json")));
    await expect(searchCounties("Edgecombe", "37", { fetchImpl: f })).rejects.toMatchObject({ code: "bad_response", message: expect.stringContaining("Invalid SQL statement") });
  });

  it("normalizes Polygon to MultiPolygon, closes rings, and rejects junk", () => {
    expect(toMultiPolygon({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] })).toEqual({
      type: "MultiPolygon",
      coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]],
    });
    expect(toMultiPolygon({ type: "Point", coordinates: [0, 0] })).toBeNull();
    expect(toMultiPolygon({ type: "Polygon", coordinates: [[[0, 0], [1, "x"], [1, 1], [0, 0]]] })).toBeNull();
    expect(parseVintage("Counties (or statistically equivalent entities); January 1, 2026 vintage")).toBe("January 1, 2026");
    expect(parseVintage("no vintage text")).toBeNull();
  });
});

describe("Overpass", () => {
  const BBOX: BBox = [-77.55, 35.88, -77.52, 35.91];

  it("converts ways: closed buildings → Polygon, roads and bridges → LineString, with OSM ids", async () => {
    const f = mockFetch(() => jsonResponse(fixtureJson("overpass-ways.json")));
    const r = await fetchOsmFeatures(BBOX, ["roads", "buildings", "bridges"], undefined, { fetchImpl: f, endpoint: "https://overpass.example/api/interpreter", now: NOW });
    expect(r.features.map((x) => [x.externalId, x.geometry.type, x.properties.category])).toEqual([
      ["way/1113399861", "Polygon", "buildings"],
      ["way/1113399870", "Polygon", "buildings"],
      ["way/111878149", "LineString", "roads"],
      ["way/388316725", "LineString", "roads"],
      ["way/38333056", "LineString", "bridges"],
      ["way/38333059", "LineString", "bridges"],
    ]);
    const bridge = r.features[4]!;
    expect(bridge.properties.categories).toEqual(["bridges", "roads"]);
    expect(bridge.geometry.type === "LineString" && bridge.geometry.coordinates[0]).toEqual([-77.5378774, 35.8874216]);
    const building = r.features[0]!;
    expect(building.geometry.type === "Polygon" && building.geometry.coordinates[0]!.length).toBe(5);
    expect(r).toMatchObject({
      truncated: false,
      attribution: "© OpenStreetMap contributors",
      license: "ODbL-1.0",
      licenseUrl: "https://www.openstreetmap.org/copyright",
      osmBase: "2026-10-15T19:52:36Z",
      retrievedAt: "2026-10-15T20:00:00.000Z",
    });
    expect(f.calls[0]!.init!.method).toBe("POST");
    expect(new URLSearchParams(String(f.calls[0]!.init!.body)).get("data")).toBe(r.query);
  });

  it("drops elements outside the requested categories", async () => {
    const f = mockFetch(() => jsonResponse(fixtureJson("overpass-ways.json")));
    const r = await fetchOsmFeatures(BBOX, ["buildings"], undefined, { fetchImpl: f, endpoint: "https://overpass.example/api/interpreter" });
    expect(r.features.map((x) => x.externalId)).toEqual(["way/1113399861", "way/1113399870"]);
  });

  it("builds a bbox-scoped query with a feature cap", () => {
    const q = buildOverpassQuery(BBOX, ["roads", "waterways"]);
    expect(q.startsWith("[out:json][timeout:25][bbox:35.880000,-77.550000,35.910000,-77.520000];(")).toBe(true);
    expect(q).toContain('way["waterway"~"^(river|stream|canal|drain|ditch)$"];');
    expect(q.endsWith(`out geom ${OVERPASS_MAX_FEATURES + 1};`)).toBe(true);
    expect(() => buildOverpassQuery(BBOX, [])).toThrow(RangeError);
  });

  it("caps the bbox area and validates its shape", async () => {
    expect(() => validateBbox([-78, 35.5, -77.5, 36])).toThrow(/limit is 400 km²/);
    expect(() => validateBbox([-77.5, 35, -77.6, 36])).toThrow(RangeError);
    expect(() => validateBbox([-77.55, 35.88, -77.52, Number.NaN])).toThrow(RangeError);
    expect(validateBbox(BBOX)).toEqual(BBOX);
    const f = mockFetch(() => jsonResponse({ elements: [] }));
    await expect(fetchOsmFeatures([-80, 34, -76, 37], ["roads"], undefined, { fetchImpl: f })).rejects.toThrow(RangeError);
    expect(f.calls).toHaveLength(0);
  });

  it("reports truncation and Overpass runtime errors", async () => {
    const way = fixtureJson<{ elements: unknown[] }>("overpass-ways.json").elements[0]!;
    const many = { elements: Array.from({ length: OVERPASS_MAX_FEATURES + 1 }, (_, i) => ({ ...(way as object), id: i + 1 })) };
    const r = await fetchOsmFeatures(BBOX, ["buildings"], undefined, { fetchImpl: mockFetch(() => jsonResponse(many)), endpoint: "https://overpass.example/i" });
    expect(r.truncated).toBe(true);
    expect(r.features).toHaveLength(OVERPASS_MAX_FEATURES);

    const timeout = { elements: [], remark: "runtime error: Query timed out in \"query\" at line 1 after 26 seconds." };
    await expect(fetchOsmFeatures(BBOX, ["roads"], undefined, { fetchImpl: mockFetch(() => jsonResponse(timeout)), endpoint: "https://overpass.example/i" })).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
    });
  });

  it("maps facility nodes to points and skips ways with missing geometry", () => {
    const point = elementToFeature({ type: "node", id: 7, lat: 35.9, lon: -77.5, tags: { amenity: "fire_station" } }, new Set(["critical_facilities"]));
    expect(point).toEqual({
      externalId: "node/7",
      geometry: { type: "Point", coordinates: [-77.5, 35.9] },
      properties: { osm_type: "node", osm_id: 7, category: "critical_facilities", categories: ["critical_facilities"], tags: { amenity: "fire_station" } },
    });
    expect(elementToFeature({ type: "way", id: 8, tags: { building: "yes" }, geometry: [{ lat: 1, lon: 1 }, null, { lat: 1, lon: 2 }] }, new Set(["buildings"]))).toBeNull();
  });
});
