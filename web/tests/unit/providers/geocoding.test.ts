import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetHostLimiter } from "@/server/providers/http";
import { geocodeAddress } from "@/server/providers/geocoding/census";
import { geocode, parsePlaceQuery, STATE_FIPS } from "@/server/providers/geocoding/index";
import { fixtureJson, jsonResponse, mockFetch, textResponse } from "./_mock-fetch";

beforeAll(() => {
  vi.stubEnv("LOG_LEVEL", "error");
});
beforeEach(() => resetHostLimiter());

function routes() {
  return mockFetch((url) => {
    const u = new URL(url);
    if (u.host === "geocoding.geo.census.gov") {
      return jsonResponse(fixtureJson(u.searchParams.get("address")!.startsWith("500") ? "census-geocoder-match.json" : "census-geocoder-nomatch.json"));
    }
    if (u.pathname.endsWith("/MapServer/4/query")) return jsonResponse(fixtureJson("tigerweb-place-search.json"));
    return jsonResponse({ features: [] });
  });
}

describe("geocode", () => {
  it("resolves coordinates locally without any request", async () => {
    const f = routes();
    const r = await geocode("35.8968, -77.5358", { fetchImpl: f });
    expect(r).toEqual([{ label: "35.89680° N, 77.53580° W", position: [-77.5358, 35.8968], kind: "coordinates", source: "Coordinates entered" }]);
    const dms = await geocode(`35°53'48"N 77°32'09"W`, { fetchImpl: f });
    expect(dms[0]!.kind).toBe("coordinates");
    expect(f.calls).toHaveLength(0);
  });

  it("geocodes street addresses with the Census geocoder", async () => {
    const f = routes();
    const r = await geocode("500 N Main St, Tarboro, NC 27886", { fetchImpl: f });
    expect(r).toEqual([
      { label: "500 N MAIN ST, TARBORO, NC, 27886", position: [-77.535387357128, 35.898319489112], kind: "address", source: "U.S. Census Bureau Geocoder (Public_AR_Current)" },
    ]);
    const q = new URL(f.calls[0]!.url).searchParams;
    expect(q.get("benchmark")).toBe("Public_AR_Current");
    expect(q.get("format")).toBe("json");
    expect(f.calls).toHaveLength(1);
  });

  it("resolves 'Tarboro, NC' through TIGERweb with the state FIPS filter", async () => {
    const f = routes();
    const r = await geocode("Tarboro, NC", { fetchImpl: f });
    expect(r[0]).toEqual({
      label: "Tarboro town, NC",
      position: [-77.5555414, 35.9042418],
      kind: "place",
      source: "U.S. Census Bureau TIGERweb (Incorporated Places, GEOID 3766700)",
    });
    expect(new URL(f.calls[0]!.url).searchParams.get("where")).toContain("STATE='37'");
  });

  it("includes matching saved AOIs first", async () => {
    const f = routes();
    const r = await geocode("Tarboro", {
      fetchImpl: f,
      savedAois: [
        { id: "a1", name: "Tarboro water plant", bbox: [-77.56, 35.89, -77.54, 35.9] },
        { id: "a2", name: "Rocky Mount depot", center: [-77.8, 35.94] },
      ],
    });
    expect(r[0]).toMatchObject({ kind: "aoi", aoiId: "a1", label: "Tarboro water plant", source: "Saved AOI" });
    expect(r[0]!.position[0]).toBeCloseTo(-77.55);
    expect(r[1]!.kind).toBe("place");
  });

  it("returns partial results when one source fails, and throws when every source fails", async () => {
    const failing = mockFetch(() => textResponse("unavailable", 503));
    await expect(geocode("Tarboro, NC", { fetchImpl: failing })).rejects.toMatchObject({ code: "unavailable" });
    const withAoi = await geocode("Tarboro", { fetchImpl: failing, savedAois: [{ id: "a1", name: "Tarboro", center: [-77.5, 35.9] }] });
    expect(withAoi.map((r) => r.kind)).toEqual(["aoi"]);
  }, 20_000);

  it("parses place queries with state abbreviations or names", () => {
    expect(parsePlaceQuery("Tarboro, NC")).toEqual({ name: "Tarboro", stateAbbr: "NC", stateFips: "37" });
    expect(parsePlaceQuery("Tarboro NC")).toEqual({ name: "Tarboro", stateAbbr: "NC", stateFips: "37" });
    expect(parsePlaceQuery("Edgecombe County, North Carolina")).toEqual({ name: "Edgecombe County", stateAbbr: "NC", stateFips: "37" });
    expect(parsePlaceQuery("Tarboro")).toEqual({ name: "Tarboro", stateAbbr: null, stateFips: null });
    expect(parsePlaceQuery("Paris, France")).toBeNull();
    expect(STATE_FIPS.NC).toBe("37");
    expect(Object.keys(STATE_FIPS)).toHaveLength(56);
  });

  it("returns no address match as an empty list", async () => {
    const f = routes();
    expect(await geocodeAddress("Tarboro, NC", { fetchImpl: f })).toEqual([]);
  });
});
