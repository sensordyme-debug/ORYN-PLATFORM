/**
 * The map's contract for basemaps and overlays. The provider catalog
 * (src/lib/map-layers.ts) is adapted into these shapes; the map component
 * depends only on this file.
 */
export type MapBasemap =
  | { id: string; label: string; kind: "raster"; tiles: string; tileSize: number; maxNativeZoom?: number; attribution: string; license: string; notes?: string; historical?: boolean }
  | { id: string; label: string; kind: "vector-style"; styleUrl: string; attribution: string; license: string; notes?: string };

export type MapOverlay = {
  id: string;
  label: string;
  tiles: string;
  tileSize: number;
  maxNativeZoom?: number;
  opacity?: number;
  attribution: string;
  license: string;
  notes?: string;
};
