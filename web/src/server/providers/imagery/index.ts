/**
 * Imagery provider registry.
 *
 * Product ids are "<provider>:<collection>". Lookups return the provider
 * adapter together with the product descriptor, so callers can check
 * capabilities (search / assetAccess) and availability before use.
 *
 *   earth-search:sentinel-2-l2a           search + public COG access
 *   planetary-computer:sentinel-1-rtc     search + SAS-signed access
 *   planetary-computer:landsat-c2-l2      search + SAS-signed access
 *   planetary-computer:sentinel-2-l2a     search + SAS-signed access (catalog fallback; not an analytics input)
 *   planetary-computer:esa-worldcover     search + SAS-signed access
 *   planetary-computer:io-lulc-annual-v02 search + SAS-signed access
 *   copernicus-dataspace:sentinel-2-l2a   catalog only
 *   nasa-cmr:hls                          search; access needs EARTHDATA_TOKEN
 */
import { copernicus } from "@/server/providers/imagery/copernicus";
import { earthSearch } from "@/server/providers/imagery/earth-search";
import { nasaCmr } from "@/server/providers/imagery/nasa-cmr";
import { planetaryComputer } from "@/server/providers/imagery/planetary-computer";
import type { ImageryProvider, ProductDescriptor } from "@/server/providers/types";

export const IMAGERY_PROVIDERS: Readonly<Record<string, ImageryProvider>> = Object.freeze({
  [earthSearch.descriptor.id]: earthSearch,
  [planetaryComputer.descriptor.id]: planetaryComputer,
  [copernicus.descriptor.id]: copernicus,
  [nasaCmr.descriptor.id]: nasaCmr,
});

export function getImageryProvider(providerId: string): ImageryProvider | null {
  return Object.hasOwn(IMAGERY_PROVIDERS, providerId) ? IMAGERY_PROVIDERS[providerId]! : null;
}

export function getImageryProduct(productId: string): { provider: ImageryProvider; product: ProductDescriptor } | null {
  const sep = productId.indexOf(":");
  if (sep <= 0) return null;
  const provider = getImageryProvider(productId.slice(0, sep));
  const product = provider?.descriptor.products.find((p) => p.id === productId);
  return provider && product ? { provider, product } : null;
}

export function listImageryProducts(): { provider: ImageryProvider; product: ProductDescriptor }[] {
  return Object.values(IMAGERY_PROVIDERS).flatMap((provider) => provider.descriptor.products.map((product) => ({ provider, product })));
}

/** Products that can feed an analytic (e.g. "ndvi"), in registry order. */
export function productsForAnalytic(analyticId: string): { provider: ImageryProvider; product: ProductDescriptor }[] {
  return listImageryProducts().filter(({ product }) => product.analytics.includes(analyticId));
}
