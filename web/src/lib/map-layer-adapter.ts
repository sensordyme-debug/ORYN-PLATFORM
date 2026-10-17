/** Adapts the provider layer catalog (src/lib/map-layers.ts) to the map component's contract. */
import { BASEMAPS, DEFAULT_BASEMAP_ID, OVERLAYS, type MapLayer } from "@/lib/map-layers";
import type { MapBasemap, MapOverlay } from "@/lib/map-layer-types";

function toBasemap(l: MapLayer): MapBasemap | null {
  if (l.kind === "vector-style" && l.styleUrl) return { id: l.id, label: l.label, kind: "vector-style", styleUrl: l.styleUrl, attribution: l.attribution, license: l.license, notes: l.notes };
  if (l.kind === "raster" && l.tileUrl) return { id: l.id, label: l.label, kind: "raster", tiles: l.tileUrl, tileSize: l.tileSize ?? 256, maxNativeZoom: l.maxNativeZoom, attribution: l.attribution, license: l.license, notes: l.notes, historical: l.historical };
  return null;
}

/** Basemaps with `preferred` (or the catalog default) first. */
export function mapBasemaps(preferred: string = DEFAULT_BASEMAP_ID): MapBasemap[] {
  const list = BASEMAPS.map(toBasemap).filter((b): b is MapBasemap => b !== null);
  const first = list.some((b) => b.id === preferred) ? preferred : DEFAULT_BASEMAP_ID;
  return [...list.filter((b) => b.id === first), ...list.filter((b) => b.id !== first)];
}

export function mapOverlays(): MapOverlay[] {
  return OVERLAYS.filter((l) => l.kind === "raster" && l.tileUrl).map((l) => ({
    id: l.id,
    label: l.label,
    tiles: l.tileUrl!,
    tileSize: l.tileSize ?? 256,
    maxNativeZoom: l.maxNativeZoom,
    opacity: l.defaultOpacity,
    attribution: l.attribution,
    license: l.license,
    notes: l.notes,
  }));
}
