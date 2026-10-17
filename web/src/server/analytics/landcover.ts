/**
 * Land-cover class tables and AOI composition.
 *
 * Class codes and labels are exactly those published in the Planetary
 * Computer STAC collections (retrieved 2026-10-15):
 *   esa-worldcover       item_assets.map["classification:classes"] — value,
 *                        description, color-hint (the official ESA palette).
 *   io-lulc-annual-v02   item_assets.data["file:values"] — values, summary.
 *                        The STAC metadata has no colours; the palette below
 *                        is the TIFF ColorMap embedded in the provider's COGs
 *                        (read from 18S_20230101-20240101.tif), i.e. the
 *                        Impact Observatory / Esri palette.
 *
 * Composition counts pixels whose centre is inside the AOI. A pixel is
 * "valid" when it carries a published land-cover class. Nodata (0), codes
 * not in the table, and IO's "Clouds" class (10 — "no land cover information
 * due to persistent cloud cover") are not land cover and are excluded from
 * the valid set. Class areas sum per-row pixel areas (exact on the WGS 84
 * ellipsoid for EPSG:4326 WorldCover tiles); `fraction` is the class's share
 * of the valid AREA, which equals the pixel share on projected grids.
 */
import type { LandcoverMetrics } from "./types";
import { nominalPixelAreaM2, rowAreasM2, type Grid } from "./raster/grid";
import type { TypedArray } from "./raster/resample";

export type LandcoverProduct = "esa-worldcover" | "io-lulc-annual-v02";

export type LandcoverClass = {
  code: number;
  label: string;
  /** "#rrggbb" from the provider's published palette. */
  color: string;
  /** False for classes that carry no land-cover information (e.g. IO "Clouds"). */
  isLandCover: boolean;
};

export type LandcoverTable = {
  product: LandcoverProduct;
  /** STAC asset key holding the classification raster. */
  assetKey: string;
  nodata: number;
  classes: LandcoverClass[];
  paletteSource: string;
};

export const WORLDCOVER_TABLE: LandcoverTable = {
  product: "esa-worldcover",
  assetKey: "map",
  nodata: 0,
  paletteSource: "STAC classification:classes color-hint (ESA WorldCover)",
  classes: [
    { code: 10, label: "Tree cover", color: "#006400", isLandCover: true },
    { code: 20, label: "Shrubland", color: "#ffbb22", isLandCover: true },
    { code: 30, label: "Grassland", color: "#ffff4c", isLandCover: true },
    { code: 40, label: "Cropland", color: "#f096ff", isLandCover: true },
    { code: 50, label: "Built-up", color: "#fa0000", isLandCover: true },
    { code: 60, label: "Bare / sparse vegetation", color: "#b4b4b4", isLandCover: true },
    { code: 70, label: "Snow and ice", color: "#f0f0f0", isLandCover: true },
    { code: 80, label: "Permanent water bodies", color: "#0064c8", isLandCover: true },
    { code: 90, label: "Herbaceous wetland", color: "#0096a0", isLandCover: true },
    { code: 95, label: "Mangroves", color: "#00cf75", isLandCover: true },
    { code: 100, label: "Moss and lichen", color: "#fae6a0", isLandCover: true },
  ],
};

export const IO_LULC_V02_TABLE: LandcoverTable = {
  product: "io-lulc-annual-v02",
  assetKey: "data",
  nodata: 0,
  paletteSource: "TIFF ColorMap embedded in the Impact Observatory COGs (not published in STAC)",
  classes: [
    { code: 1, label: "Water", color: "#419bdf", isLandCover: true },
    { code: 2, label: "Trees", color: "#397d49", isLandCover: true },
    { code: 4, label: "Flooded vegetation", color: "#7a87c6", isLandCover: true },
    { code: 5, label: "Crops", color: "#e49635", isLandCover: true },
    { code: 7, label: "Built area", color: "#c4281b", isLandCover: true },
    { code: 8, label: "Bare ground", color: "#a59b8f", isLandCover: true },
    { code: 9, label: "Snow/ice", color: "#a8ebff", isLandCover: true },
    { code: 10, label: "Clouds", color: "#616161", isLandCover: false },
    { code: 11, label: "Rangeland", color: "#e3e2c3", isLandCover: true },
  ],
};

export const LANDCOVER_TABLES: Record<LandcoverProduct, LandcoverTable> = {
  "esa-worldcover": WORLDCOVER_TABLE,
  "io-lulc-annual-v02": IO_LULC_V02_TABLE,
};

export type CompositionResult = {
  metrics: LandcoverMetrics;
  /** 1 where the pixel is inside the AOI and carries a land-cover class. */
  valid: Uint8Array;
  totalPixels: number;
  validPixels: number;
  /** Inside the AOI but nodata / outside the file footprint. */
  noDataPixels: number;
  /** Inside the AOI with a published non-land-cover class (IO "Clouds"). */
  nonLandCoverPixels: number;
  /** Inside the AOI with a code the table does not define. */
  unknownPixels: number;
  unknownCodes: number[];
};

export function composition(
  codes: TypedArray,
  inside: Uint8Array,
  grid: Grid,
  table: LandcoverTable,
  footprint?: Uint8Array | null,
): CompositionResult {
  const byCode = new Map(table.classes.map((c) => [c.code, c]));
  const pixels = new Map<number, number>();
  const areas = new Map<number, number>();
  const unknown = new Set<number>();
  const rowArea = rowAreasM2(grid);
  const valid = new Uint8Array(codes.length);
  let total = 0;
  let validPixels = 0;
  let validArea = 0;
  let noData = 0;
  let nonLandCover = 0;
  let unknownPixels = 0;

  for (let r = 0; r < grid.height; r++) {
    const a = rowArea[r]!;
    for (let c = 0; c < grid.width; c++) {
      const i = r * grid.width + c;
      if (!inside[i]) continue;
      total++;
      const code = codes[i]!;
      if ((footprint && !footprint[i]) || code === table.nodata || Number.isNaN(code)) {
        noData++;
        continue;
      }
      const cls = byCode.get(code);
      if (!cls) {
        unknownPixels++;
        unknown.add(code);
        continue;
      }
      if (!cls.isLandCover) {
        nonLandCover++;
        continue;
      }
      valid[i] = 1;
      validPixels++;
      validArea += a;
      pixels.set(code, (pixels.get(code) ?? 0) + 1);
      areas.set(code, (areas.get(code) ?? 0) + a);
    }
  }

  const classes = table.classes
    .filter((c) => (pixels.get(c.code) ?? 0) > 0)
    .map((c) => {
      const area = areas.get(c.code)!;
      return { code: c.code, label: c.label, pixels: pixels.get(c.code)!, fraction: validArea > 0 ? area / validArea : 0, area_m2: area };
    })
    .sort((a, b) => b.area_m2 - a.area_m2 || a.code - b.code);

  return {
    metrics: {
      classes,
      valid_fraction: total > 0 ? validPixels / total : 0,
      total_pixels: total,
      pixel_area_m2: nominalPixelAreaM2(grid),
    },
    valid,
    totalPixels: total,
    validPixels,
    noDataPixels: noData,
    nonLandCoverPixels: nonLandCover,
    unknownPixels,
    unknownCodes: [...unknown].sort((a, b) => a - b),
  };
}
