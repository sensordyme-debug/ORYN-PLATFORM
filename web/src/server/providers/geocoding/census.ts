/**
 * U.S. Census Bureau geocoder — one-line address → coordinates.
 *
 * GET https://geocoding.geo.census.gov/geocoder/locations/onelineaddress
 *   ?address=…&benchmark=Public_AR_Current&format=json
 * Matches are interpolated along TIGER address ranges (street segments), so a
 * position is an estimate along the block face, not a rooftop or parcel
 * point. U.S. addresses only. No credentials; public domain results.
 */
import { httpJson, ProviderError, type FetchLike } from "@/server/providers/http";
import type { GeocodeResult, ProviderDescriptor } from "@/server/providers/types";

export const CENSUS_GEOCODER_ID = "census-geocoder";
const ENDPOINT = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
const BENCHMARK = "Public_AR_Current";
export const CENSUS_GEOCODER_SOURCE = `U.S. Census Bureau Geocoder (${BENCHMARK})`;

export const CENSUS_GEOCODER_DESCRIPTOR: ProviderDescriptor = {
  id: CENSUS_GEOCODER_ID,
  name: "Census Geocoder",
  kind: "geocoding",
  operator: "U.S. Census Bureau",
  homepage: "https://geocoding.geo.census.gov/geocoder/",
  docsUrl: "https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html",
  products: [
    {
      id: "census-geocoder:onelineaddress",
      name: "Address geocoding (address-range interpolation)",
      collection: "onelineaddress",
      kind: "vector",
      analytics: [],
      capabilities: { search: true, assetAccess: false },
      notes: "U.S. addresses only. Positions are interpolated along street segments, not rooftop points.",
    },
  ],
  licensing: {
    summary: "Results are works of the U.S. Government (Census Bureau) and not subject to U.S. copyright; API use is subject to the Census Bureau terms of service.",
    url: "https://www.census.gov/data/developers/about/terms-of-service.html",
    redistribution: "Unrestricted.",
    commercialUse: "allowed",
    attribution: "Source: U.S. Census Bureau Geocoder",
  },
  credentials: { required: false, envVars: [] },
  updateCadence: "Benchmark address ranges are refreshed periodically by the Census Bureau.",
  delivery: "polling",
};

type CensusResponse = {
  result?: {
    addressMatches?: { matchedAddress?: string; coordinates?: { x?: number; y?: number } }[];
  };
};

export async function geocodeAddress(address: string, opts: { fetchImpl?: FetchLike; signal?: AbortSignal } = {}): Promise<GeocodeResult[]> {
  const a = address.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  if (a.length < 3 || a.length > 200) throw new RangeError("Address must be 3–200 characters");
  const params = new URLSearchParams({ address: a, benchmark: BENCHMARK, format: "json" });
  const res = await httpJson<CensusResponse>(`${ENDPOINT}?${params.toString()}`, {
    providerId: CENSUS_GEOCODER_ID,
    signal: opts.signal,
    fetchImpl: opts.fetchImpl,
    timeoutMs: 20_000,
  });
  const matches = res.result?.addressMatches;
  if (!Array.isArray(matches)) throw new ProviderError(CENSUS_GEOCODER_ID, "bad_response", "Census geocoder response has no addressMatches", { retryable: false });
  const out: GeocodeResult[] = [];
  for (const m of matches) {
    const x = m.coordinates?.x;
    const y = m.coordinates?.y;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90) continue;
    out.push({ label: m.matchedAddress ?? a, position: [x, y], kind: "address", source: CENSUS_GEOCODER_SOURCE });
  }
  return out;
}
