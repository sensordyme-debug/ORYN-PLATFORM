/**
 * Copernicus Data Space Ecosystem (CDSE) — the official Copernicus catalog.
 *
 * STAC endpoint: https://stac.dataspace.copernicus.eu/v1 (verified
 * 2026-10-15; https://catalogue.dataspace.copernicus.eu/stac serves the same
 * catalog). Search is anonymous. Assets are the original SAFE JPEG 2000
 * files: the primary href is s3://eodata/… and the HTTPS alternate is an
 * OData download URL that requires an OAuth2 bearer token.
 *
 * ORYN's raster reader consumes Cloud-Optimized GeoTIFFs, so this product is
 * catalog-only (capabilities.assetAccess = false): it records what Copernicus
 * has published, e.g. to confirm a scene exists before a mirror has it.
 * resolveAccess() exists for completeness: without CDSE_CLIENT_ID /
 * CDSE_CLIENT_SECRET it throws ProviderError "unconfigured"; with them it
 * obtains a client-credentials token and returns the HTTPS URL + header.
 * That download path was not verified against the live service (no
 * credentials were available when this adapter was written).
 */
import { env } from "@/server/config/env";
import { httpJson, ProviderError, timedProbe, type FetchLike } from "@/server/providers/http";
import { getStacCollection, requireAssetFile, searchStacProduct, type StacClient, type StacCollectionConfig } from "@/server/providers/stac";
import type { ImageryProvider, ProductDescriptor, ProviderAvailability, ProviderDescriptor } from "@/server/providers/types";

export const COPERNICUS_ID = "copernicus-dataspace";
export const CDSE_TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token";
const LICENSE_URL = "https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice";

export const CDSE_S2_L2A: StacCollectionConfig = {
  collection: "sentinel-2-l2a",
  kind: "optical",
  processingLevel: "L2A",
  cloudCoverQueryable: true,
  assetMap: {
    red: "B04_10m",
    green: "B03_10m",
    blue: "B02_10m",
    nir: "B08_10m",
    nir08: "B8A_20m",
    swir16: "B11_20m",
    swir22: "B12_20m",
    scl: "SCL_20m",
    visual: "TCI_10m",
  },
  license: {
    license: "Copernicus Sentinel data terms (free, full and open)",
    licenseUrl: LICENSE_URL,
    attribution: "Contains modified Copernicus Sentinel data [year]",
  },
};

export const COPERNICUS_PRODUCTS: ProductDescriptor[] = [
  {
    id: "copernicus-dataspace:sentinel-2-l2a",
    name: "Sentinel-2 Level-2A (Copernicus Data Space catalog)",
    collection: "sentinel-2-l2a",
    kind: "optical",
    gsdM: 10,
    revisitDays: 5,
    analytics: [],
    capabilities: { search: true, assetAccess: false },
    notes:
      "Catalog only: assets are JPEG 2000 inside SAFE products (s3:// or authenticated OData download), not COGs readable by ORYN's raster reader.",
  },
];

export const COPERNICUS_DESCRIPTOR: ProviderDescriptor = {
  id: COPERNICUS_ID,
  name: "Copernicus Data Space Ecosystem",
  kind: "imagery",
  operator: "European Commission / ESA (operated by a consortium led by CloudFerro)",
  homepage: "https://dataspace.copernicus.eu/",
  docsUrl: "https://documentation.dataspace.copernicus.eu/APIs/STAC.html",
  products: COPERNICUS_PRODUCTS,
  licensing: {
    summary:
      "Copernicus Sentinel data are free, full and open under the Copernicus Sentinel data terms; use, modification and redistribution, including commercial, are permitted with attribution. Data Space service quotas and terms: see provider terms.",
    url: LICENSE_URL,
    redistribution: "Permitted with the attribution “Contains modified Copernicus Sentinel data [year]”.",
    commercialUse: "allowed",
    attribution: "Contains modified Copernicus Sentinel data [year]",
  },
  credentials: { required: false, envVars: ["CDSE_CLIENT_ID", "CDSE_CLIENT_SECRET", "CDSE_STAC_URL"] },
  updateCadence: "Continuous as ESA publishes products.",
  delivery: "polling",
  rateLimit: "Quotas apply to downloads; see provider terms.",
};

export function copernicusAvailability(creds?: { clientId?: string; clientSecret?: string }): ProviderAvailability {
  const id = creds ? creds.clientId : env.cdseClientId();
  const secret = creds ? creds.clientSecret : env.cdseClientSecret();
  const missing = [!id && "CDSE_CLIENT_ID", !secret && "CDSE_CLIENT_SECRET"].filter(Boolean);
  if (missing.length === 0) return { state: "available" };
  return {
    state: "unconfigured",
    reason: `Catalog search works anonymously, but asset download needs OAuth2 client credentials: set ${missing.join(" and ")}.`,
  };
}

export type CopernicusDeps = {
  fetchImpl?: FetchLike;
  baseUrl?: string;
  clientId?: string;
  clientSecret?: string;
  tokenUrl?: string;
  now?: () => number;
};

export function createCopernicusProvider(deps: CopernicusDeps = {}): ImageryProvider {
  const now = deps.now ?? Date.now;
  const client = (): StacClient => ({ providerId: COPERNICUS_ID, baseUrl: deps.baseUrl ?? env.cdseStacUrl(), fetchImpl: deps.fetchImpl });
  const creds = () =>
    "clientId" in deps || "clientSecret" in deps
      ? { clientId: deps.clientId, clientSecret: deps.clientSecret }
      : { clientId: env.cdseClientId(), clientSecret: env.cdseClientSecret() };
  let cached: { token: string; expiresAt: number } | null = null;

  async function accessToken(signal?: AbortSignal): Promise<string> {
    const { clientId, clientSecret } = creds();
    if (!clientId || !clientSecret) {
      throw new ProviderError(COPERNICUS_ID, "unconfigured", copernicusAvailabilityReason(clientId, clientSecret), { retryable: false });
    }
    if (cached && cached.expiresAt - 60_000 > now()) return cached.token;
    const res = await httpJson<{ access_token?: unknown; expires_in?: unknown }>(deps.tokenUrl ?? CDSE_TOKEN_URL, {
      providerId: COPERNICUS_ID,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }).toString(),
      signal,
      retries: 1,
      fetchImpl: deps.fetchImpl,
    });
    if (typeof res.access_token !== "string" || typeof res.expires_in !== "number") {
      throw new ProviderError(COPERNICUS_ID, "bad_response", "CDSE token response missing access_token or expires_in", { retryable: false });
    }
    cached = { token: res.access_token, expiresAt: now() + res.expires_in * 1000 };
    return cached.token;
  }

  return {
    descriptor: COPERNICUS_DESCRIPTOR,
    availability: () => copernicusAvailability(creds()),
    async search(q) {
      if (q.productId !== "copernicus-dataspace:sentinel-2-l2a") {
        throw new ProviderError(COPERNICUS_ID, "not_found", `Unknown product ${q.productId}`, { retryable: false });
      }
      return searchStacProduct(client(), [CDSE_S2_L2A], q);
    },
    async resolveAccess(asset, key, signal) {
      const file = requireAssetFile(COPERNICUS_ID, asset, key);
      const token = await accessToken(signal);
      return { url: file.href, headers: { Authorization: `Bearer ${token}` } };
    },
    health(signal) {
      return timedProbe(async () => {
        const c = await getStacCollection(client(), CDSE_S2_L2A.collection, signal);
        return { ok: c.id === CDSE_S2_L2A.collection, details: { collection: c.id, assetAccess: copernicusAvailability(creds()).state } };
      });
    },
  };
}

function copernicusAvailabilityReason(clientId: string | undefined, clientSecret: string | undefined): string {
  const a = copernicusAvailability({ clientId, clientSecret });
  return a.state === "available" ? "" : a.reason;
}

export const copernicus = createCopernicusProvider();
