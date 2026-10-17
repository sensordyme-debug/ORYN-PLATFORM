/**
 * Element 84 Earth Search — Sentinel-2 Level-2A Cloud-Optimized GeoTIFFs on
 * AWS Open Data (public, unsigned HTTPS range reads).
 *
 * Asset keys: Earth Search names bands by common name (red = B04, nir = B08,
 * nir08 = B8A, swir16 = B11, swir22 = B12, scl = SCL, visual = TCI). The
 * "-jp2" duplicates point at s3:// JPEG 2000 files and are ignored.
 *
 * BOA offset caveat: items with properties["earthsearch:boa_offset_applied"]
 * === true publish raster:bands offset −0.1, but their pixel values already
 * have the L2A BOA offset removed (the collection's item_assets state offset
 * 0, and the raster engine verified identical DNs across baselines 03.01 and
 * 05.00). Applying −0.1 again would bias reflectance low. This adapter does
 * NOT rewrite band metadata: raster:bands are kept exactly as published and
 * the flag is always carried in NormalizedAsset.properties, so the pipeline
 * can override the offset and record a quality flag.
 */
import { env } from "@/server/config/env";
import { timedProbe, ProviderError, type FetchLike } from "@/server/providers/http";
import { getStacCollection, requireAssetFile, searchStacProduct, type StacClient, type StacCollectionConfig } from "@/server/providers/stac";
import type { ImageryProvider, ProductDescriptor, ProviderDescriptor } from "@/server/providers/types";

export const EARTH_SEARCH_ID = "earth-search";

const COPERNICUS_LICENSE_URL = "https://sentinel.esa.int/documents/247904/690755/Sentinel_Data_Legal_Notice";

export const EARTH_SEARCH_S2_L2A: StacCollectionConfig = {
  collection: "sentinel-2-l2a",
  kind: "optical",
  processingLevel: "L2A",
  cloudCoverQueryable: true,
  assetMap: {
    red: "red",
    green: "green",
    blue: "blue",
    nir: "nir",
    nir08: "nir08",
    swir16: "swir16",
    swir22: "swir22",
    scl: "scl",
    visual: "visual",
  },
  license: {
    license: "Copernicus Sentinel data terms (free, full and open)",
    licenseUrl: COPERNICUS_LICENSE_URL,
    attribution: "Contains modified Copernicus Sentinel data [year]",
  },
};

export const EARTH_SEARCH_PRODUCTS: ProductDescriptor[] = [
  {
    id: "earth-search:sentinel-2-l2a",
    name: "Sentinel-2 Level-2A surface reflectance (COG)",
    collection: "sentinel-2-l2a",
    kind: "optical",
    gsdM: 10,
    revisitDays: 5,
    analytics: ["ndvi", "ndmi", "ndwi"],
    capabilities: { search: true, assetAccess: true },
    notes:
      "10 m (B02/B03/B04/B08), 20 m (B8A/B11/B12/SCL). Public COGs, no credentials. raster:bands are kept as published; when properties[\"earthsearch:boa_offset_applied\"] is true the published −0.1 offset is already applied to the pixel values and must not be applied again.",
  },
];

export const EARTH_SEARCH_DESCRIPTOR: ProviderDescriptor = {
  id: EARTH_SEARCH_ID,
  name: "Earth Search (Element 84)",
  kind: "imagery",
  operator: "Element 84 (catalog); data hosted by AWS Open Data; Sentinel-2 by ESA / Copernicus",
  homepage: "https://element84.com/earth-search/",
  docsUrl: "https://earth-search.aws.element84.com/v1/api.html",
  products: EARTH_SEARCH_PRODUCTS,
  licensing: {
    summary:
      "Copernicus Sentinel data are provided free, full and open under the Copernicus Sentinel data terms: use, reproduction, modification and redistribution, including commercial, are permitted with attribution.",
    url: COPERNICUS_LICENSE_URL,
    redistribution: "Imagery and derived products may be redistributed with the attribution “Contains modified Copernicus Sentinel data [year]”.",
    commercialUse: "allowed",
    attribution: "Contains modified Copernicus Sentinel data [year]",
  },
  credentials: { required: false, envVars: ["EARTH_SEARCH_STAC_URL"] },
  updateCadence: "Continuous as ESA publishes Level-2A products (a 2026-10-08 scene was catalogued about 8 hours after acquisition).",
  delivery: "polling",
  rateLimit: "See provider terms; ORYN retries 429/5xx with backoff.",
};

export type EarthSearchDeps = { fetchImpl?: FetchLike; baseUrl?: string };

export function createEarthSearchProvider(deps: EarthSearchDeps = {}): ImageryProvider {
  const client = (): StacClient => ({ providerId: EARTH_SEARCH_ID, baseUrl: deps.baseUrl ?? env.earthSearchUrl(), fetchImpl: deps.fetchImpl });
  const configs: Record<string, StacCollectionConfig[]> = { "earth-search:sentinel-2-l2a": [EARTH_SEARCH_S2_L2A] };

  return {
    descriptor: EARTH_SEARCH_DESCRIPTOR,
    availability: () => ({ state: "available" }),
    async search(q) {
      const product = configs[q.productId];
      if (!product) throw new ProviderError(EARTH_SEARCH_ID, "not_found", `Unknown product ${q.productId}`, { retryable: false });
      return searchStacProduct(client(), product, q);
    },
    async resolveAccess(asset, key) {
      return { url: requireAssetFile(EARTH_SEARCH_ID, asset, key).href };
    },
    health(signal) {
      return timedProbe(async () => {
        const c = await getStacCollection(client(), EARTH_SEARCH_S2_L2A.collection, signal);
        return { ok: c.id === EARTH_SEARCH_S2_L2A.collection, details: { collection: c.id } };
      });
    },
  };
}

export const earthSearch = createEarthSearchProvider();
