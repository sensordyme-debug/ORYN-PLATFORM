/**
 * NASA CMR-STAC (LP DAAC cloud) — Harmonized Landsat Sentinel-2 (HLS) v2.0.
 *
 * Collections (ids verified 2026-10-15): HLSS30_2.0 (Sentinel-2 MSI) and
 * HLSL30_2.0 (Landsat 8/9 OLI), both 30 m on the Sentinel-2 MGRS tiling.
 * Search is public. Band files are separate COGs on
 * data.lpdaac.earthdatacloud.nasa.gov that require an Earthdata Login bearer
 * token (unauthenticated reads redirect to the login page).
 *
 * Canonical keys: the harmonized narrow NIR band (S30 B8A, L30 B05) is
 * exposed as both "nir" and "nir08"; red = B04, green = B03, blue = B02,
 * swir16 = S30 B11 / L30 B06, swir22 = S30 B12 / L30 B07, fmask = Fmask.
 * The CMR STAC items carry no projection or raster:bands metadata, so EPSG,
 * scale and offset are left unset here and must be read from each COG.
 * The MGRS grid code is parsed from the HLS granule id
 * (HLS.<sensor>.T<tile>.<yyyydddThhmmss>.v2.0).
 */
import { env } from "@/server/config/env";
import { integrationGate } from "@/server/integrations";
import { ProviderError, timedProbe, type FetchLike } from "@/server/providers/http";
import {
  getStacCollection,
  requireAssetFile,
  searchStacProduct,
  type StacClient,
  type StacCollectionConfig,
  type StacItem,
} from "@/server/providers/stac";
import type { ImageryProvider, ProductDescriptor, ProviderAvailability, ProviderDescriptor } from "@/server/providers/types";

export const NASA_CMR_ID = "nasa-cmr";
const DATA_POLICY_URL = "https://earthdata.nasa.gov/earth-observation-data/data-use-policy";

export function hlsGridCode(item: Pick<StacItem, "id">): string | null {
  const m = /^HLS\.[LS]30\.T(\d{2}[A-Z]{3})\./.exec(item.id);
  return m ? `MGRS-${m[1]}` : null;
}

export const HLS_S30: StacCollectionConfig = {
  collection: "HLSS30_2.0",
  kind: "optical",
  processingLevel: "L3",
  cloudCoverQueryable: true,
  assetMap: { red: "B04", green: "B03", blue: "B02", nir: "B8A", nir08: "B8A", swir16: "B11", swir22: "B12", fmask: "Fmask" },
  gridCode: hlsGridCode,
  license: {
    license: "CC0-1.0 (NASA Earth science data use policy)",
    licenseUrl: DATA_POLICY_URL,
    attribution: "HLS S30 v2.0, NASA EOSDIS LP DAAC (doi:10.5067/HLS/HLSS30.002); contains modified Copernicus Sentinel data [year]",
  },
};

export const HLS_L30: StacCollectionConfig = {
  collection: "HLSL30_2.0",
  kind: "optical",
  processingLevel: "L3",
  cloudCoverQueryable: true,
  assetMap: { red: "B04", green: "B03", blue: "B02", nir: "B05", nir08: "B05", swir16: "B06", swir22: "B07", fmask: "Fmask" },
  gridCode: hlsGridCode,
  license: {
    license: "CC0-1.0 (NASA Earth science data use policy)",
    licenseUrl: DATA_POLICY_URL,
    attribution: "HLS L30 v2.0, NASA EOSDIS LP DAAC (doi:10.5067/HLS/HLSL30.002)",
  },
};

export const NASA_CMR_PRODUCTS: ProductDescriptor[] = [
  {
    id: "nasa-cmr:hls",
    name: "Harmonized Landsat Sentinel-2 (HLS) v2.0, 30 m",
    collection: "hls",
    kind: "optical",
    gsdM: 30,
    revisitDays: 3,
    analytics: [],
    capabilities: { search: true, assetAccess: true },
    notes:
      "Searches HLSS30_2.0 and HLSL30_2.0 together. Asset reads need EARTHDATA_TOKEN. Not yet an input to ORYN analytics: CMR items carry no scale/offset or projection metadata (read them from the COG).",
  },
];

export const NASA_CMR_DESCRIPTOR: ProviderDescriptor = {
  id: NASA_CMR_ID,
  name: "NASA CMR-STAC (LP DAAC)",
  kind: "imagery",
  operator: "NASA Earthdata (Common Metadata Repository; LP DAAC)",
  homepage: "https://www.earthdata.nasa.gov/",
  docsUrl: "https://cmr.earthdata.nasa.gov/stac/",
  products: NASA_CMR_PRODUCTS,
  licensing: {
    summary:
      "NASA Earth science data are openly shared without restriction on use (NASA Earth Science Data Use Policy; the HLS collections declare CC0-1.0). Data citation is requested. HLS S30 is derived from Copernicus Sentinel-2.",
    url: DATA_POLICY_URL,
    redistribution: "Permitted; cite the HLS dataset DOI and, for S30, include the Copernicus Sentinel attribution.",
    commercialUse: "allowed",
    attribution: "NASA EOSDIS LP DAAC — HLS v2.0",
  },
  credentials: { required: true, envVars: ["EARTHDATA_TOKEN", "NASA_CMR_STAC_URL"] },
  updateCadence: "Continuous as LP DAAC publishes HLS granules.",
  delivery: "polling",
  rateLimit: "See provider terms.",
};

/** Availability from the configured EARTHDATA_TOKEN. */
export function nasaCmrAvailability(): ProviderAvailability {
  return availabilityForToken(env.earthdataToken());
}

function availabilityForToken(token: string | undefined): ProviderAvailability {
  if (token) {
    const gate = integrationGate("nasa-hls");
    return gate.enabled ? { state: "available" } : { state: "disabled", reason: gate.reason };
  }
  return {
    state: "unconfigured",
    reason: "EARTHDATA_TOKEN is not set: HLS catalog search is public, but reading HLS files requires an Earthdata Login bearer token.",
  };
}

export type NasaCmrDeps = { fetchImpl?: FetchLike; baseUrl?: string; token?: string };

export function createNasaCmrProvider(deps: NasaCmrDeps = {}): ImageryProvider {
  const client = (): StacClient => ({ providerId: NASA_CMR_ID, baseUrl: deps.baseUrl ?? env.cmrStacUrl(), fetchImpl: deps.fetchImpl, timeoutMs: 45_000 });
  const token = () => ("token" in deps ? deps.token : env.earthdataToken());

  return {
    descriptor: NASA_CMR_DESCRIPTOR,
    availability: () => availabilityForToken(token()),
    async search(q) {
      if (q.productId !== "nasa-cmr:hls") throw new ProviderError(NASA_CMR_ID, "not_found", `Unknown product ${q.productId}`, { retryable: false });
      return searchStacProduct(client(), [HLS_S30, HLS_L30], q);
    },
    async resolveAccess(asset, key) {
      const t = token();
      if (!t) {
        const a = availabilityForToken(t);
        throw new ProviderError(NASA_CMR_ID, "unconfigured", a.state === "available" ? "EARTHDATA_TOKEN is not set" : a.reason, { retryable: false });
      }
      const file = requireAssetFile(NASA_CMR_ID, asset, key);
      return { url: file.href, headers: { Authorization: `Bearer ${t}` } };
    },
    health(signal) {
      return timedProbe(async () => {
        const c = await getStacCollection(client(), HLS_S30.collection, signal);
        return { ok: c.id === HLS_S30.collection, details: { collection: c.id, assetAccess: availabilityForToken(token()).state } };
      });
    },
  };
}

export const nasaCmr = createNasaCmrProvider();
