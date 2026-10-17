/**
 * Microsoft Planetary Computer — STAC catalog plus Azure Blob Storage COGs.
 *
 * Asset reads need a short-lived SAS token per collection:
 *   GET {sas}/token/{collection} → { "msft:expiry": ISO, token: "st=…&se=…&sig=…" }
 * The token is appended as the query string of the blob URL. Tokens are
 * cached per collection until five minutes before expiry; concurrent callers
 * share one in-flight token request. An optional subscription key
 * (PLANETARY_COMPUTER_SUBSCRIPTION_KEY) is sent as Ocp-Apim-Subscription-Key.
 * Anonymous tokens worked for every collection below when verified on
 * 2026-10-15; the Sentinel-1 RTC description states an account may be
 * required, in which case the key must be configured.
 *
 * Only *.blob.core.windows.net hrefs are signed; others pass through.
 * Signed URLs are secrets until they expire — never log or persist them.
 */
import { env } from "@/server/config/env";
import { httpJson, ProviderError, timedProbe, type FetchLike } from "@/server/providers/http";
import { getStacCollection, requireAssetFile, searchStacProduct, type StacClient, type StacCollectionConfig } from "@/server/providers/stac";
import type { ImageryProvider, ProductDescriptor, ProviderDescriptor } from "@/server/providers/types";

export const PLANETARY_COMPUTER_ID = "planetary-computer";

const COPERNICUS_LICENSE_URL = "https://sentinel.esa.int/documents/247904/690755/Sentinel_Data_Legal_Notice";
const CC_BY_4 = "https://creativecommons.org/licenses/by/4.0/";

export const PC_COLLECTIONS = {
  "sentinel-1-rtc": {
    collection: "sentinel-1-rtc",
    kind: "sar",
    processingLevel: "RTC (from Level-1 GRD)",
    cloudCoverQueryable: false,
    assetMap: { vv: "vv", vh: "vh" },
    license: {
      license: "CC-BY-4.0",
      licenseUrl: CC_BY_4,
      attribution: "Contains modified Copernicus Sentinel data [year], radiometrically terrain corrected by Catalyst (Microsoft Planetary Computer)",
    },
  },
  "landsat-c2-l2": {
    collection: "landsat-c2-l2",
    kind: "optical",
    processingLevel: "L2SP",
    cloudCoverQueryable: true,
    assetMap: { red: "red", green: "green", blue: "blue", nir08: "nir08", swir16: "swir16", swir22: "swir22", qa_pixel: "qa_pixel" },
    license: {
      license: "Public domain (USGS)",
      licenseUrl: "https://www.usgs.gov/core-science-systems/hdds/data-policy",
      attribution: "Landsat imagery courtesy of the U.S. Geological Survey",
    },
  },
  "sentinel-2-l2a": {
    collection: "sentinel-2-l2a",
    kind: "optical",
    processingLevel: "L2A",
    cloudCoverQueryable: true,
    assetMap: { red: "B04", green: "B03", blue: "B02", nir: "B08", nir08: "B8A", swir16: "B11", swir22: "B12", scl: "SCL", visual: "visual" },
    license: {
      license: "Copernicus Sentinel data terms (free, full and open)",
      licenseUrl: COPERNICUS_LICENSE_URL,
      attribution: "Contains modified Copernicus Sentinel data [year]",
    },
  },
  "esa-worldcover": {
    collection: "esa-worldcover",
    kind: "landcover",
    processingLevel: null,
    cloudCoverQueryable: false,
    assetMap: { map: "map" },
    license: {
      license: "CC-BY-4.0",
      licenseUrl: "https://spdx.org/licenses/CC-BY-4.0.html",
      attribution: "© ESA WorldCover project [year] / Contains modified Copernicus Sentinel data ([year]) processed by ESA WorldCover consortium",
    },
  },
  "io-lulc-annual-v02": {
    collection: "io-lulc-annual-v02",
    kind: "landcover",
    processingLevel: null,
    cloudCoverQueryable: false,
    // The provider's key is "data"; "map" is an alias so land-cover analytics read one key for every product.
    assetMap: { data: "data", map: "data" },
    license: {
      license: "CC-BY-4.0",
      licenseUrl: CC_BY_4,
      attribution: "Land use/land cover © Impact Observatory, Microsoft, and Esri ([year])",
    },
  },
} as const satisfies Record<string, StacCollectionConfig>;

export const PLANETARY_COMPUTER_PRODUCTS: ProductDescriptor[] = [
  {
    id: "planetary-computer:sentinel-1-rtc",
    name: "Sentinel-1 radiometrically terrain-corrected backscatter (IW, VV/VH)",
    collection: "sentinel-1-rtc",
    kind: "sar",
    gsdM: 10,
    revisitDays: 12,
    analytics: ["s1-water"],
    capabilities: { search: true, assetAccess: true },
    notes:
      "Gamma-nought in linear power units (float32, nodata −32768). Scenes are orthorectified to UTM but not snapped to a common pixel grid: equal grid codes (relative orbit) do not imply pixel alignment. Revisit is the 12-day same-orbit repeat per satellite; on 2026-10-15 a test point in North Carolina had one satellite (Sentinel-1D) on two relative orbits, i.e. a scene every 5–7 days.",
  },
  {
    id: "planetary-computer:landsat-c2-l2",
    name: "Landsat Collection 2 Level-2 surface reflectance",
    collection: "landsat-c2-l2",
    kind: "optical",
    gsdM: 30,
    revisitDays: 8,
    analytics: ["ndvi", "ndmi"],
    capabilities: { search: true, assetAccess: true },
    notes: "Landsat 8/9 (and earlier missions in the archive). SR scale 2.75e-05, offset −0.2 per raster:bands; QA_PIXEL bit mask.",
  },
  {
    id: "planetary-computer:sentinel-2-l2a",
    name: "Sentinel-2 Level-2A (Planetary Computer mirror)",
    collection: "sentinel-2-l2a",
    kind: "optical",
    gsdM: 10,
    revisitDays: 5,
    analytics: [],
    capabilities: { search: true, assetAccess: true },
    notes:
      "Catalog fallback only. These assets carry no raster:bands scale/offset; for processing baseline ≥ 04.00 the L2A BOA offset (−1000 DN) must be applied, so ORYN analytics use the Earth Search product instead.",
  },
  {
    id: "planetary-computer:esa-worldcover",
    name: "ESA WorldCover 10 m land cover (2020 v100, 2021 v200)",
    collection: "esa-worldcover",
    kind: "landcover",
    gsdM: 10,
    analytics: ["landcover-composition"],
    capabilities: { search: true, assetAccess: true },
    notes: "Annual maps; item time is a year-long interval. Tiles are 3°×3° in EPSG:4326.",
  },
  {
    id: "planetary-computer:io-lulc-annual-v02",
    name: "Impact Observatory 10 m annual land use/land cover (9-class) v2",
    collection: "io-lulc-annual-v02",
    kind: "landcover",
    gsdM: 10,
    analytics: ["landcover-composition"],
    capabilities: { search: true, assetAccess: true },
    notes: "Annual maps 2017–2023 (per collection metadata); asset exposed as both \"data\" (provider key) and \"map\".",
  },
];

export const PLANETARY_COMPUTER_DESCRIPTOR: ProviderDescriptor = {
  id: PLANETARY_COMPUTER_ID,
  name: "Microsoft Planetary Computer",
  kind: "imagery",
  operator: "Microsoft",
  homepage: "https://planetarycomputer.microsoft.com/",
  docsUrl: "https://planetarycomputer.microsoft.com/docs/",
  products: PLANETARY_COMPUTER_PRODUCTS,
  licensing: {
    summary:
      "Licence is per collection, from each collection's STAC metadata: Sentinel-1 RTC, ESA WorldCover and Impact Observatory LULC are CC BY 4.0; Landsat Collection 2 is public domain (USGS); Sentinel-2 follows the Copernicus Sentinel data terms. Use of the Planetary Computer service itself: see provider terms.",
    url: "https://planetarycomputer.microsoft.com/docs/",
    redistribution: "Permitted for all listed collections; CC BY 4.0 and Copernicus collections require the attribution recorded on each asset.",
    commercialUse: "allowed",
    attribution: "Per asset (see each asset's attribution)",
  },
  credentials: { required: false, envVars: ["PLANETARY_COMPUTER_SUBSCRIPTION_KEY", "PLANETARY_COMPUTER_STAC_URL", "PLANETARY_COMPUTER_SAS_URL"] },
  updateCadence: "Per collection: Sentinel-1/2 and Landsat continuously as published upstream; land-cover products annually.",
  delivery: "polling",
  rateLimit: "See provider documentation; a subscription key (optional) is sent with SAS token requests when configured.",
};

// ── SAS tokens ────────────────────────────────────────────────

export type SasTokenCacheOptions = {
  sasUrl?: string;
  subscriptionKey?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
};

const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export function createSasTokenCache(opts: SasTokenCacheOptions = {}) {
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { token: string; expiresAt: number }>();
  const inflight = new Map<string, Promise<string>>();

  async function fetchToken(collection: string, signal?: AbortSignal): Promise<string> {
    const base = (opts.sasUrl ?? env.planetaryComputerSasUrl()).replace(/\/+$/, "");
    const key = opts.subscriptionKey ?? env.planetaryComputerKey();
    const res = await httpJson<{ "msft:expiry"?: unknown; token?: unknown }>(`${base}/token/${encodeURIComponent(collection)}`, {
      providerId: PLANETARY_COMPUTER_ID,
      headers: key ? { "Ocp-Apim-Subscription-Key": key } : undefined,
      signal,
      timeoutMs: 15_000,
      fetchImpl: opts.fetchImpl,
    });
    const expiresAt = typeof res["msft:expiry"] === "string" ? Date.parse(res["msft:expiry"]) : NaN;
    if (typeof res.token !== "string" || !res.token || !Number.isFinite(expiresAt)) {
      throw new ProviderError(PLANETARY_COMPUTER_ID, "bad_response", "SAS token response missing token or msft:expiry", { retryable: false });
    }
    cache.set(collection, { token: res.token, expiresAt });
    return res.token;
  }

  return {
    async token(collection: string, signal?: AbortSignal): Promise<string> {
      const hit = cache.get(collection);
      if (hit && hit.expiresAt - EXPIRY_MARGIN_MS > now()) return hit.token;
      const pending = inflight.get(collection);
      if (pending) return pending;
      const p = fetchToken(collection, signal).finally(() => inflight.delete(collection));
      inflight.set(collection, p);
      return p;
    },
    clear() {
      cache.clear();
    },
  };
}

/** Append a SAS token to an Azure blob URL; non-blob URLs are returned unchanged. */
export function signBlobUrl(href: string, token: string): string {
  let host: string;
  try {
    host = new URL(href).hostname;
  } catch {
    return href;
  }
  if (!host.endsWith(".blob.core.windows.net")) return href;
  return `${href}${href.includes("?") ? "&" : "?"}${token.replace(/^\?/, "")}`;
}

// ── Provider ──────────────────────────────────────────────────

export type PlanetaryComputerDeps = { fetchImpl?: FetchLike; baseUrl?: string; sasUrl?: string; subscriptionKey?: string; now?: () => number };

export function createPlanetaryComputerProvider(deps: PlanetaryComputerDeps = {}): ImageryProvider {
  const client = (): StacClient => ({
    providerId: PLANETARY_COMPUTER_ID,
    baseUrl: deps.baseUrl ?? env.planetaryComputerUrl(),
    fetchImpl: deps.fetchImpl,
  });
  const tokens = createSasTokenCache({ sasUrl: deps.sasUrl, subscriptionKey: deps.subscriptionKey, fetchImpl: deps.fetchImpl, now: deps.now });
  const products: Record<string, StacCollectionConfig[]> = Object.fromEntries(
    Object.values(PC_COLLECTIONS).map((c) => [`${PLANETARY_COMPUTER_ID}:${c.collection}`, [c]]),
  );

  return {
    descriptor: PLANETARY_COMPUTER_DESCRIPTOR,
    availability: () => ({ state: "available" }),
    async search(q) {
      const configs = products[q.productId];
      if (!configs) throw new ProviderError(PLANETARY_COMPUTER_ID, "not_found", `Unknown product ${q.productId}`, { retryable: false });
      return searchStacProduct(client(), configs, q);
    },
    async resolveAccess(asset, key, signal) {
      const file = requireAssetFile(PLANETARY_COMPUTER_ID, asset, key);
      const token = await tokens.token(asset.collection, signal);
      return { url: signBlobUrl(file.href, token) };
    },
    health(signal) {
      return timedProbe(async () => {
        const c = await getStacCollection(client(), "landsat-c2-l2", signal);
        return { ok: c.id === "landsat-c2-l2", details: { collection: c.id } };
      });
    },
  };
}

export const planetaryComputer = createPlanetaryComputerProvider();
