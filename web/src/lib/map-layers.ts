/**
 * Catalog of web map layers the UI can display. Isomorphic: no server
 * imports, safe for client components.
 *
 * These layers are for display and visual context only; ORYN analytics never
 * read them. Every layer lists the attribution the map must show, a licence
 * summary, and known limits. Tile endpoints and zoom limits were checked on
 * 2026-10-15:
 *   - USGS The National Map cached services return tiles through z16 and
 *     404 at z17 (maxNativeZoom 16; MapLibre overzooms beyond that).
 *   - FEMA NFHL "Flood Hazard Zones" (MapServer layer 28) has a minimum
 *     scale of 1:36,112, so the export draws nothing below web zoom 15 with
 *     256-px tiles. The service can be slow; tiles may load late.
 *   - OpenFreeMap serves a MapLibre style (vector tiles); no key.
 */

export type MapLayerRole = "basemap" | "overlay";
export type MapLayerKind = "raster" | "vector-style";

export type MapLayer = {
  id: string;
  label: string;
  role: MapLayerRole;
  kind: MapLayerKind;
  /** Provider id in the server-side provider registry. */
  providerId: string;
  /** Raster tile URL template ({z}/{x}/{y} or {bbox-epsg-3857}), for kind "raster". */
  tileUrl?: string;
  /** MapLibre style URL, for kind "vector-style". */
  styleUrl?: string;
  tileSize?: 256 | 512;
  minZoom: number;
  maxZoom: number;
  /** Highest zoom with native tiles; the map overzooms above it. */
  maxNativeZoom?: number;
  /** Plain-text attribution (no HTML). */
  attribution: string;
  license: string;
  sourceUrl: string;
  /** Suggested opacity for overlays. */
  defaultOpacity?: number;
  /** Area covered, when not global. */
  coverage?: string;
  notes?: string;
  /** Imagery of past dates (e.g. an orthoimagery mosaic): the map labels it as not current conditions. */
  historical?: boolean;
};

const NATIONAL_MAP = "https://basemap.nationalmap.gov/arcgis/rest/services";
const USGS_LICENSE = "U.S. public domain (USGS-produced data); credit “USGS The National Map” is requested.";

export const MAP_LAYERS: readonly MapLayer[] = [
  {
    id: "usgs-imagery",
    label: "USGS imagery",
    role: "basemap",
    kind: "raster",
    providerId: "usgs-national-map",
    tileUrl: `${NATIONAL_MAP}/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}`,
    tileSize: 256,
    minZoom: 0,
    maxZoom: 20,
    maxNativeZoom: 16,
    attribution: "USDA, USGS The National Map: Orthoimagery",
    license: USGS_LICENSE,
    sourceUrl: `${NATIONAL_MAP}/USGSImageryOnly/MapServer`,
    coverage: "United States",
    notes: "Orthoimagery mosaic of varying dates (the service states its last refresh); not current conditions.",
    historical: true,
  },
  {
    id: "usgs-topo",
    label: "USGS topographic",
    role: "basemap",
    kind: "raster",
    providerId: "usgs-national-map",
    tileUrl: `${NATIONAL_MAP}/USGSTopo/MapServer/tile/{z}/{y}/{x}`,
    tileSize: 256,
    minZoom: 0,
    maxZoom: 20,
    maxNativeZoom: 16,
    attribution:
      "USGS The National Map: National Boundaries Dataset, 3DEP Elevation Program, Geographic Names Information System, National Hydrography Dataset, National Land Cover Database, National Structures Dataset",
    license: USGS_LICENSE,
    sourceUrl: `${NATIONAL_MAP}/USGSTopo/MapServer`,
    coverage: "United States",
  },
  {
    id: "openfreemap-liberty",
    label: "Streets (OpenFreeMap)",
    role: "basemap",
    kind: "vector-style",
    providerId: "openfreemap",
    styleUrl: "https://tiles.openfreemap.org/styles/liberty",
    minZoom: 0,
    maxZoom: 22,
    attribution: "OpenFreeMap © OpenMapTiles Data from OpenStreetMap",
    license:
      "Map data © OpenStreetMap contributors (ODbL 1.0); OpenMapTiles schema; OpenFreeMap public instance is free, provided as-is without SLA.",
    sourceUrl: "https://openfreemap.org/",
    notes: "Bulk tile downloads are limited by the OpenFreeMap terms; interactive display only.",
  },
  {
    id: "usgs-shaded-relief",
    label: "Shaded relief",
    role: "overlay",
    kind: "raster",
    providerId: "usgs-national-map",
    tileUrl: `${NATIONAL_MAP}/USGSShadedReliefOnly/MapServer/tile/{z}/{y}/{x}`,
    tileSize: 256,
    minZoom: 0,
    maxZoom: 20,
    maxNativeZoom: 16,
    attribution: "USGS The National Map: 3D Elevation Program; USGS EROS: GMTED2010",
    license: USGS_LICENSE,
    sourceUrl: `${NATIONAL_MAP}/USGSShadedReliefOnly/MapServer`,
    defaultOpacity: 0.35,
    coverage: "United States",
    notes: "Opaque JPEG tiles: use partial opacity over a basemap.",
  },
  {
    id: "usgs-hydro",
    label: "Hydrography (NHD)",
    role: "overlay",
    kind: "raster",
    providerId: "usgs-national-map",
    tileUrl: `${NATIONAL_MAP}/USGSHydroCached/MapServer/tile/{z}/{y}/{x}`,
    tileSize: 256,
    minZoom: 0,
    maxZoom: 20,
    maxNativeZoom: 16,
    attribution: "USGS The National Map: National Hydrography Dataset",
    license: USGS_LICENSE,
    sourceUrl: `${NATIONAL_MAP}/USGSHydroCached/MapServer`,
    defaultOpacity: 0.9,
    coverage: "United States",
    notes: "Mapped streams and water bodies; not observed water extent.",
  },
  {
    id: "fema-nfhl-flood-zones",
    label: "FEMA flood hazard zones",
    role: "overlay",
    kind: "raster",
    providerId: "fema-nfhl",
    tileUrl:
      "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image&layers=show:28",
    tileSize: 256,
    minZoom: 15,
    maxZoom: 20,
    attribution: "FEMA National Flood Hazard Layer (NFHL)",
    license: "U.S. Government data (FEMA); see provider terms.",
    sourceUrl: "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28",
    defaultOpacity: 0.6,
    coverage: "United States communities with digital flood maps",
    notes:
      "Regulatory flood hazard mapping (effective FIRM data), not observed or forecast flooding. Coverage and currency vary by community. Drawn only at zoom 15 and above (service scale limit).",
  },
];

export const BASEMAPS: readonly MapLayer[] = MAP_LAYERS.filter((l) => l.role === "basemap");
export const OVERLAYS: readonly MapLayer[] = MAP_LAYERS.filter((l) => l.role === "overlay");
export const DEFAULT_BASEMAP_ID = "openfreemap-liberty";

export function getMapLayer(id: string): MapLayer | null {
  return MAP_LAYERS.find((l) => l.id === id) ?? null;
}
