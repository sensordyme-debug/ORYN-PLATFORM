/**
 * Location search for the map and AOI tools.
 *
 * Order of resolution:
 *   1. Coordinates ("35.8968, -77.5358", DMS, hemisphere letters) — parsed
 *      locally, no network.
 *   2. The organization's saved AOIs whose name matches (when supplied).
 *   3. U.S. street addresses (queries containing a digit) — Census geocoder.
 *   4. U.S. place and county names ("Tarboro, NC", "Edgecombe County, NC") —
 *      TIGERweb, with an optional state abbreviation or name mapped to FIPS.
 * Every result names its source. A failing remote source does not hide
 * results from the others; if every attempted source fails, the first error
 * is thrown.
 */
import { bboxCenter, formatLatLon, parseCoordinates, type BBox, type Position } from "@/lib/geo";
import { log } from "@/server/log";
import { geocodeAddress } from "@/server/providers/geocoding/census";
import type { FetchLike } from "@/server/providers/http";
import { searchCounties, searchPlaces, TIGERWEB_LAYERS, type CensusGeography } from "@/server/providers/reference/tigerweb";
import type { GeocodeResult } from "@/server/providers/types";

/** USPS abbreviation → state FIPS code (50 states, DC, and inhabited territories). */
export const STATE_FIPS: Readonly<Record<string, string>> = {
  AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06", CO: "08", CT: "09", DE: "10", DC: "11", FL: "12",
  GA: "13", HI: "15", ID: "16", IL: "17", IN: "18", IA: "19", KS: "20", KY: "21", LA: "22", ME: "23",
  MD: "24", MA: "25", MI: "26", MN: "27", MS: "28", MO: "29", MT: "30", NE: "31", NV: "32", NH: "33",
  NJ: "34", NM: "35", NY: "36", NC: "37", ND: "38", OH: "39", OK: "40", OR: "41", PA: "42", RI: "44",
  SC: "45", SD: "46", TN: "47", TX: "48", UT: "49", VT: "50", VA: "51", WA: "53", WV: "54", WI: "55",
  WY: "56", AS: "60", GU: "66", MP: "69", PR: "72", VI: "78",
};

const STATE_NAMES: Readonly<Record<string, string>> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT",
  delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA",
  "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "american samoa": "AS", guam: "GU", "northern mariana islands": "MP", "puerto rico": "PR", "u.s. virgin islands": "VI",
};

const ABBR_BY_FIPS: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(STATE_FIPS).map(([abbr, fips]) => [fips, abbr]));

export type PlaceQuery = { name: string; stateAbbr: string | null; stateFips: string | null };

/** "Tarboro, NC" | "Tarboro NC" | "Tarboro, North Carolina" | "Tarboro" → name + optional state. */
export function parsePlaceQuery(q: string): PlaceQuery | null {
  const s = q.replace(/\s+/g, " ").trim();
  if (!s) return null;
  const comma = s.lastIndexOf(",");
  if (comma > 0) {
    const name = s.slice(0, comma).trim();
    const suffix = s.slice(comma + 1).trim().replace(/\.$/, "");
    const abbr = stateAbbr(suffix);
    if (abbr && name) return { name, stateAbbr: abbr, stateFips: STATE_FIPS[abbr]! };
    if (/^(usa|us|united states)$/i.test(suffix) && name) return parsePlaceQuery(name);
    return null;
  }
  const m = /^(.+?)\s+([A-Z]{2})$/.exec(s);
  if (m && STATE_FIPS[m[2]!]) return { name: m[1]!, stateAbbr: m[2]!, stateFips: STATE_FIPS[m[2]!]! };
  return { name: s, stateAbbr: null, stateFips: null };
}

function stateAbbr(s: string): string | null {
  const up = s.toUpperCase();
  if (STATE_FIPS[up]) return up;
  return STATE_NAMES[s.toLowerCase()] ?? null;
}

export type SavedAoiRef = { id: string; name: string; center?: Position; bbox?: BBox };

export type GeocodeOptions = {
  savedAois?: SavedAoiRef[];
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  /** Maximum results (default 10). */
  limit?: number;
};

export async function geocode(query: string, opts: GeocodeOptions = {}): Promise<GeocodeResult[]> {
  const q = query.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));
  if (!q || q.length > 200) return [];

  const coords = parseCoordinates(q);
  if (coords) return [{ label: formatLatLon(coords), position: coords, kind: "coordinates", source: "Coordinates entered" }];

  const results: GeocodeResult[] = [...matchSavedAois(q, opts.savedAois ?? [])];
  const errors: unknown[] = [];
  let attempted = 0;

  if (/\d/.test(q) && q.length >= 5) {
    attempted++;
    try {
      results.push(...(await geocodeAddress(q, { fetchImpl: opts.fetchImpl, signal: opts.signal })));
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      errors.push(e);
      log.warn("address geocoding failed", { error: e });
    }
  }

  if (!results.some((r) => r.kind === "address")) {
    const place = parsePlaceQuery(q);
    if (place && isSearchableName(place.name)) {
      attempted++;
      try {
        results.push(...(await placeResults(place, opts)));
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        errors.push(e);
        log.warn("place geocoding failed", { error: e });
      }
    }
  }

  if (results.length === 0 && attempted > 0 && errors.length === attempted) throw errors[0];
  return results.slice(0, limit);
}

function isSearchableName(name: string): boolean {
  return /^[\p{L}\p{M}0-9 .'’-]{2,100}$/u.test(name) && /\p{L}/u.test(name);
}

async function placeResults(place: PlaceQuery, opts: GeocodeOptions): Promise<GeocodeResult[]> {
  const tw = { fetchImpl: opts.fetchImpl, signal: opts.signal };
  const stateFips = place.stateFips ?? undefined;
  const geographies: CensusGeography[] = /\b(county|parish|borough|census area|municipio)$/i.test(place.name)
    ? await searchCounties(place.name, stateFips, tw)
    : await searchPlaces(place.name, stateFips, tw);
  return geographies
    .filter((g) => g.position !== null)
    .map((g) => ({
      label: `${g.name}, ${ABBR_BY_FIPS[g.stateFips] ?? g.stateFips}`,
      position: g.position!,
      kind: "place" as const,
      source: `U.S. Census Bureau TIGERweb (${TIGERWEB_LAYERS[g.kind].name}, GEOID ${g.geoid})`,
    }));
}

function matchSavedAois(q: string, aois: SavedAoiRef[]): GeocodeResult[] {
  const needle = q.toLowerCase();
  const out: GeocodeResult[] = [];
  for (const a of aois) {
    if (!a.name.toLowerCase().includes(needle)) continue;
    const position = a.center ?? (a.bbox ? bboxCenter(a.bbox) : null);
    if (!position) continue;
    out.push({ label: a.name, position, ...(a.bbox ? { bbox: a.bbox } : {}), kind: "aoi", source: "Saved AOI", aoiId: a.id });
  }
  return out;
}
