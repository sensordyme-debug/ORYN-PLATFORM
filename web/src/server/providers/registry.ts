/**
 * Provider registry: static metadata (descriptors, licensing), availability
 * gates (credentials, licence), and cheap health probes for every external
 * source ORYN uses. Runtime health is persisted by the provider health job in
 * provider_status; nothing here writes to the database.
 *
 * Availability states
 *   available     the provider can be used as configured
 *   unconfigured  a credential or identification is missing (reason names the env var)
 *   disabled      turned off, or licence terms forbid use as configured
 *
 * Health probes make one small request each and never throw. Providers that
 * are disabled or unconfigured with nothing public to probe are reported as
 * skipped rather than probed.
 */
import { getMapLayer, MAP_LAYERS } from "@/lib/map-layers";
import { env } from "@/server/config/env";
import { CENSUS_GEOCODER_DESCRIPTOR, CENSUS_GEOCODER_ID } from "@/server/providers/geocoding/census";
import { httpJson, httpRequest, httpText, orynUserAgent, timedProbe, type FetchLike } from "@/server/providers/http";
import { copernicusAvailability, COPERNICUS_DESCRIPTOR, COPERNICUS_ID, createCopernicusProvider } from "@/server/providers/imagery/copernicus";
import { createEarthSearchProvider, EARTH_SEARCH_DESCRIPTOR, EARTH_SEARCH_ID } from "@/server/providers/imagery/earth-search";
import { getImageryProvider } from "@/server/providers/imagery/index";
import { createNasaCmrProvider, nasaCmrAvailability, NASA_CMR_DESCRIPTOR, NASA_CMR_ID } from "@/server/providers/imagery/nasa-cmr";
import {
  createPlanetaryComputerProvider,
  PLANETARY_COMPUTER_DESCRIPTOR,
  PLANETARY_COMPUTER_ID,
} from "@/server/providers/imagery/planetary-computer";
import { gdeltAvailability, GDELT_DESCRIPTOR, GDELT_ID, GDELT_MIN_INTERVAL_MS, isRateLimitMessage, parseArtlist } from "@/server/providers/news/gdelt";
import { OVERPASS_DESCRIPTOR, OVERPASS_ID } from "@/server/providers/reference/overpass";
import { TIGERWEB_BASE, TIGERWEB_DESCRIPTOR, TIGERWEB_ID, parseVintage } from "@/server/providers/reference/tigerweb";
import type { HealthResult, ImageryProvider, ProductDescriptor, ProviderAvailability, ProviderDescriptor } from "@/server/providers/types";
import { nwsAvailability, NWS_DESCRIPTOR, NWS_ID } from "@/server/providers/weather/nws";
import { openMeteoAvailability, OPEN_METEO_DESCRIPTOR, OPEN_METEO_ID } from "@/server/providers/weather/open-meteo";

export const USGS_NATIONAL_MAP_ID = "usgs-national-map";
export const FEMA_NFHL_ID = "fema-nfhl";
export const OPENFREEMAP_ID = "openfreemap";

function tileProducts(providerId: string): ProductDescriptor[] {
  return MAP_LAYERS.filter((l) => l.providerId === providerId).map((l) => ({
    id: `${providerId}:${l.id}`,
    name: l.label,
    collection: l.id,
    kind: l.kind === "vector-style" ? "vector" : "raster_tiles",
    analytics: [],
    capabilities: { search: false, assetAccess: false },
    notes: [`Display only (web map ${l.kind === "vector-style" ? "style" : "tiles"}).`, l.notes].filter(Boolean).join(" "),
  }));
}

const USGS_NATIONAL_MAP_DESCRIPTOR: ProviderDescriptor = {
  id: USGS_NATIONAL_MAP_ID,
  name: "USGS The National Map basemaps",
  kind: "basemap",
  operator: "U.S. Geological Survey",
  homepage: "https://apps.nationalmap.gov/services/",
  docsUrl: "https://basemap.nationalmap.gov/arcgis/rest/services",
  products: tileProducts(USGS_NATIONAL_MAP_ID),
  licensing: {
    summary:
      "USGS-authored or produced data are in the U.S. public domain; the imagery service also credits USDA. Some third-party content on USGS sites is not public domain.",
    url: "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits",
    redistribution: "Permitted; credit “USGS The National Map”.",
    commercialUse: "allowed",
    attribution: "USGS The National Map",
  },
  credentials: { required: false, envVars: [] },
  updateCadence: "Cached basemaps refreshed periodically (each service states its last refresh).",
  delivery: "polling",
};

const FEMA_NFHL_DESCRIPTOR: ProviderDescriptor = {
  id: FEMA_NFHL_ID,
  name: "FEMA National Flood Hazard Layer",
  kind: "reference",
  operator: "Federal Emergency Management Agency",
  homepage: "https://www.fema.gov/flood-maps/national-flood-hazard-layer",
  docsUrl: "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer",
  products: tileProducts(FEMA_NFHL_ID),
  licensing: {
    summary:
      "U.S. Government flood hazard data published by FEMA. Regulatory mapping, not observed flooding. Reuse terms: see provider terms.",
    url: "https://www.fema.gov/flood-maps/national-flood-hazard-layer",
    redistribution: "See provider terms; cite FEMA NFHL and the effective date of the map shown.",
    commercialUse: "allowed",
    attribution: "FEMA National Flood Hazard Layer (NFHL)",
  },
  credentials: { required: false, envVars: [] },
  updateCadence: "Updated as FEMA flood map revisions become effective.",
  delivery: "polling",
};

const OPENFREEMAP_DESCRIPTOR: ProviderDescriptor = {
  id: OPENFREEMAP_ID,
  name: "OpenFreeMap",
  kind: "basemap",
  operator: "OpenFreeMap (Hyperknot Software Kft.)",
  homepage: "https://openfreemap.org/",
  docsUrl: "https://openfreemap.org/quick_start/",
  products: tileProducts(OPENFREEMAP_ID),
  licensing: {
    summary:
      "Free public vector-tile service without SLA (OpenFreeMap terms of service). Map data © OpenStreetMap contributors under the ODbL 1.0; tiles follow the OpenMapTiles schema. Attribution is required.",
    url: "https://openfreemap.org/tos/",
    redistribution: "Display with attribution; bulk downloads are limited by the OpenFreeMap terms.",
    commercialUse: "allowed",
    attribution: "OpenFreeMap © OpenMapTiles Data from OpenStreetMap",
  },
  credentials: { required: false, envVars: [] },
  updateCadence: "Planet tiles rebuilt regularly from OpenStreetMap (see provider).",
  delivery: "polling",
};

export const PROVIDERS: readonly ProviderDescriptor[] = [
  EARTH_SEARCH_DESCRIPTOR,
  PLANETARY_COMPUTER_DESCRIPTOR,
  COPERNICUS_DESCRIPTOR,
  NASA_CMR_DESCRIPTOR,
  NWS_DESCRIPTOR,
  OPEN_METEO_DESCRIPTOR,
  GDELT_DESCRIPTOR,
  TIGERWEB_DESCRIPTOR,
  OVERPASS_DESCRIPTOR,
  CENSUS_GEOCODER_DESCRIPTOR,
  USGS_NATIONAL_MAP_DESCRIPTOR,
  FEMA_NFHL_DESCRIPTOR,
  OPENFREEMAP_DESCRIPTOR,
];

export function getProviderDescriptor(id: string): ProviderDescriptor | null {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

export function providerAvailability(id: string): ProviderAvailability {
  switch (id) {
    case COPERNICUS_ID:
      return copernicusAvailability();
    case NASA_CMR_ID:
      return nasaCmrAvailability();
    case NWS_ID:
      return nwsAvailability();
    case OPEN_METEO_ID:
      return openMeteoAvailability();
    case GDELT_ID:
      return gdeltAvailability();
    default:
      return getProviderDescriptor(id) ? { state: "available" } : { state: "disabled", reason: `Unknown provider "${id}".` };
  }
}

export type HealthDeps = { fetchImpl?: FetchLike; now?: () => number };

const skipped = (a: Exclude<ProviderAvailability, { state: "available" }>): HealthResult => ({
  ok: false,
  latencyMs: 0,
  message: `Not checked: ${a.reason}`,
  details: { skipped: true, availability: a.state },
});

/** One cheap request against the provider. Never throws. */
export async function checkProviderHealth(id: string, signal?: AbortSignal, deps: HealthDeps = {}): Promise<HealthResult> {
  const availability = providerAvailability(id);
  const base = { providerId: id, signal, fetchImpl: deps.fetchImpl, retries: 0, timeoutMs: 15_000 };
  const probe = (fn: () => Promise<{ ok: boolean; message?: string; details?: Record<string, unknown> }>) =>
    timedProbe(fn, deps.now).then((r) => ({ ...r, details: { ...r.details, availability: availability.state } }));

  switch (id) {
    case EARTH_SEARCH_ID:
    case PLANETARY_COMPUTER_ID:
    case COPERNICUS_ID:
    case NASA_CMR_ID: {
      // Catalog search is public for all four; asset-access gaps are reported via availability.
      const provider = imageryProviderFor(id, deps.fetchImpl);
      const r = await provider.health(signal);
      return { ...r, details: { ...r.details, availability: availability.state } };
    }
    case NWS_ID:
      if (availability.state !== "available") return skipped(availability);
      return probe(async () => {
        const res = await httpJson<{ properties?: { gridId?: unknown } }>("https://api.weather.gov/points/39.7456,-97.0892", {
          ...base,
          userAgent: env.nwsUserAgent() ?? orynUserAgent(),
          headers: { accept: "application/geo+json" },
        });
        return { ok: typeof res.properties?.gridId === "string", details: { gridId: res.properties?.gridId ?? null } };
      });
    case OPEN_METEO_ID:
      if (availability.state !== "available") return skipped(availability);
      return probe(async () => {
        const key = env.openMeteoApiKey();
        const params = new URLSearchParams({ latitude: "39.7456", longitude: "-97.0892", daily: "temperature_2m_max", forecast_days: "1", timezone: "auto" });
        if (key) params.set("apikey", key);
        const res = await httpJson<{ daily?: { time?: unknown[] } }>(`https://${key ? "customer-" : ""}api.open-meteo.com/v1/forecast?${params}`, base);
        return { ok: Array.isArray(res.daily?.time) };
      });
    case GDELT_ID:
      if (availability.state !== "available") return skipped(availability);
      return probe(async () => {
        const params = new URLSearchParams({ query: "weather", mode: "artlist", format: "json", maxrecords: "1", timespan: "1h" });
        const text = await httpText(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`, { ...base, minIntervalMs: GDELT_MIN_INTERVAL_MS });
        if (isRateLimitMessage(text)) return { ok: false, message: "GDELT rate limit notice returned" };
        parseArtlist(text);
        return { ok: true };
      });
    case TIGERWEB_ID:
      return probe(async () => {
        const res = await httpJson<{ name?: string; description?: string }>(`${TIGERWEB_BASE}/Places_CouSub_ConCity_SubMCD/MapServer/4?f=json`, base);
        return { ok: res.name === "Incorporated Places", details: { vintage: parseVintage(res.description) } };
      });
    case OVERPASS_ID:
      return probe(async () => {
        const res = await httpJson<{ elements?: unknown[]; osm3s?: { timestamp_osm_base?: string } }>(env.overpassUrl(), {
          ...base,
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ data: "[out:json][timeout:5];node(35.8960,-77.5370,35.8962,-77.5368);out count;" }).toString(),
          minIntervalMs: 1_000,
        });
        return { ok: Array.isArray(res.elements), details: { osmBase: res.osm3s?.timestamp_osm_base ?? null } };
      });
    case CENSUS_GEOCODER_ID:
      return probe(async () => {
        const res = await httpJson<{ benchmarks?: unknown[] }>("https://geocoding.geo.census.gov/geocoder/benchmarks", base);
        return { ok: Array.isArray(res.benchmarks) && res.benchmarks.length > 0 };
      });
    case USGS_NATIONAL_MAP_ID:
    case FEMA_NFHL_ID:
    case OPENFREEMAP_ID:
      return probe(async () => {
        const url = tileProbeUrl(id);
        const res = await httpRequest(url, { ...base, headers: { accept: "*/*" }, maxBytes: 2 * 1024 * 1024 });
        const type = res.headers.get("content-type") ?? "";
        return { ok: res.status === 200 && /^(image\/|application\/json)/.test(type), details: { contentType: type } };
      });
    default:
      return { ok: false, latencyMs: 0, message: `Unknown provider "${id}"` };
  }
}

function imageryProviderFor(id: string, fetchImpl?: FetchLike): ImageryProvider {
  if (fetchImpl) {
    if (id === EARTH_SEARCH_ID) return createEarthSearchProvider({ fetchImpl });
    if (id === PLANETARY_COMPUTER_ID) return createPlanetaryComputerProvider({ fetchImpl });
    if (id === COPERNICUS_ID) return createCopernicusProvider({ fetchImpl });
    return createNasaCmrProvider({ fetchImpl });
  }
  return getImageryProvider(id)!;
}

/** A small, always-present resource per tile provider. */
function tileProbeUrl(id: string): string {
  if (id === USGS_NATIONAL_MAP_ID) return getMapLayer("usgs-topo")!.tileUrl!.replace("{z}", "0").replace("{y}", "0").replace("{x}", "0");
  if (id === FEMA_NFHL_ID) return "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28?f=json";
  return getMapLayer("openfreemap-liberty")!.styleUrl!;
}
