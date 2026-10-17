/**
 * Provider-agnostic analyses used by the processing pipeline: optical indices
 * (NDVI, NDWI, NDMI, true colour), Sentinel-1 open-water candidates, and land-cover
 * composition — each for one AOI on one scene/item.
 *
 * Grid: the AOI (lon/lat) is projected into the asset's own CRS and its
 * bounds are snapped outward onto the lattice of the finest band read from
 * the COG itself, so analysis pixels ARE source pixels (no resampling of the
 * native bands; coarser quality bands such as 20 m SCL are mapped by nearest
 * neighbour). Overviews are never used for analysis.
 *
 * Pixel accounting (all counts are pixels whose centre lies inside the AOI):
 *   total     inside the AOI
 *   covered   the source has data for every band the product needs
 *   clear     covered and passed the provider quality mask (SCL / QA_PIXEL / S1 nodata)
 *   valid     clear and the per-pixel value is defined (e.g. NIR + Red > 0)
 *   coverage_fraction = covered / total
 *   masked_fraction   = (total − clear) / total   (cloud, shadow, snow, no data)
 *   valid_fraction    = valid / total
 * Flags: partial_coverage (coverage < 0.98), high_mask_fraction (masked > 0.5),
 * below_min_valid_fraction (valid < minValidFraction), downsampled (overview
 * read); optical: reflectance_offset_overridden (see boaOffsetApplied);
 * land cover: unknown_class_codes, provider_cloud_class.
 *
 * Scaling safety: optical indices are refused (InvalidInputError
 * "implausible_reflectance") when more than 10 % of clear pixels fall below
 * −0.02 reflectance — the signature of scale/offset metadata that does not
 * match the pixel values. Wrong NDVI is never produced silently.
 *
 * Status: "unusable" when coverage is 0 or valid_fraction < minValidFraction
 * (default 0.2). Unusable outputs carry quality, the per-pixel values that
 * do exist, and a preview — but metrics are null. Nothing is ever filled in
 * or estimated.
 *
 * Every function accepts an AbortSignal, checked between band reads and
 * passed to every HTTP request. The raster opener is injectable (deps.open)
 * so tests can run against in-memory rasters.
 */
import type { MultiPolygonGeometry, PolygonGeometry } from "@/lib/geo";
import type { AssetAccess, AssetFile } from "@/server/providers/types";
import type { LandcoverMetrics, NdviMetrics, ObservationQuality, RasterRef, WaterMetrics } from "./types";
import { InvalidInputError } from "./errors";
import {
  IMPLAUSIBLE_REFLECTANCE_BELOW,
  NDWI_WATER_THRESHOLD,
  S1_WATER_THRESHOLD_DB,
  aboveThreshold,
  bandScaling,
  belowThreshold,
  implausibleReflectanceCount,
  linearToDb,
  normalizedDifference,
  type BandScaling,
} from "./indices";
import { LANDCOVER_TABLES, composition, type LandcoverProduct } from "./landcover";
import { cogOpener, type RasterOpener } from "./raster/cog";
import { DEFAULT_MAX_PIXELS, gridCornersLonLat, gridForBounds, nominalGsdM, nominalPixelAreaM2, rowAreasM2, type Grid } from "./raster/grid";
import { andMasks, countOnes, dataMask, landsatQaValidMask, s1ValidMask, sclValidMask, type MaskResult } from "./raster/masks";
import { boundsOfMultiPolygon, projectMultiPolygon } from "./raster/projection";
import { countInside, rasterizeMultiPolygon } from "./raster/rasterize";
import { readSourceToGrid, type GridRead, type RasterSource, type TypedArray } from "./raster/resample";
import { renderContinuous, renderLandcover, renderTrueColor, renderWaterMask, type Legend } from "./render";
import { histogram, meanOf, summarize } from "./stats";

export const DEFAULT_MIN_VALID_FRACTION = 0.2;
export const PARTIAL_COVERAGE_BELOW = 0.98;
export const HIGH_MASK_ABOVE = 0.5;

export type AnalysisStatus = "valid" | "unusable";

export type AnalysisOutput<M> = {
  status: AnalysisStatus;
  metrics: M | null;
  quality: ObservationQuality;
  /** Per-pixel values on the analysis grid, row-major, NaN = no value. */
  values: Float32Array;
  png: Buffer;
  legend: Legend;
};

/** The analysis grid and AOI mask shared by every output of one call. */
export type GridContext = {
  grid: Grid;
  corners: RasterRef["corners"];
  /** 1 where the pixel centre lies inside the AOI. */
  inside: Uint8Array;
  insideCount: number;
};

export type AnalyzeDeps = { open?: RasterOpener };

type CommonParams = {
  assets: Record<string, AssetFile>;
  /** AOI in lon/lat (EPSG:4326). */
  aoi: MultiPolygonGeometry | PolygonGeometry;
  /** Resolve read access (signed URL / headers) for an asset key. */
  resolve: (assetKey: string) => Promise<AssetAccess>;
  signal?: AbortSignal;
  /** Pixel budget for the analysis grid (default 25 M). */
  maxPixels?: number;
  minValidFraction?: number;
  deps?: AnalyzeDeps;
};

// ── Shared helpers ────────────────────────────────────────────

function aoiCoordinates(aoi: MultiPolygonGeometry | PolygonGeometry) {
  return aoi.type === "Polygon" ? [aoi.coordinates] : aoi.coordinates;
}

function requireAsset(assets: Record<string, AssetFile>, key: string, why: string): AssetFile {
  const a = assets[key];
  if (!a) throw new InvalidInputError("missing_asset", `The item has no "${key}" asset, which ${why} requires.`);
  return a;
}

async function openAsset(params: CommonParams, key: string): Promise<RasterSource> {
  params.signal?.throwIfAborted();
  const access = await params.resolve(key);
  params.signal?.throwIfAborted();
  return (params.deps?.open ?? cogOpener)(access, params.signal);
}

/** Analysis grid on `lattice`'s full-resolution pixel lattice, covering the AOI. */
function buildGridContext(aoi: MultiPolygonGeometry | PolygonGeometry, lattice: RasterSource, maxPixels: number): GridContext {
  const info = lattice.info;
  const full = info.levels[0];
  if (!full) throw new InvalidInputError("invalid_raster", "Raster has no full-resolution level.");
  const projected = projectMultiPolygon(aoiCoordinates(aoi), info.epsg);
  const grid = gridForBounds(boundsOfMultiPolygon(projected), [full.pixelW, full.pixelH], [info.originX, info.originY], info.epsg, { maxPixels });
  const inside = rasterizeMultiPolygon(projected, grid);
  const insideCount = countInside(inside);
  if (insideCount === 0) {
    throw new InvalidInputError(
      "aoi_too_small",
      `The area of interest contains no pixel centres on the ${Math.round(full.pixelW * 100) / 100}-unit source grid; it is smaller than one pixel.`,
    );
  }
  return { grid, corners: gridCornersLonLat(grid), inside, insideCount };
}

async function readBand(params: CommonParams, source: RasterSource, ctx: GridContext, key: string, samples?: number[]): Promise<GridRead> {
  params.signal?.throwIfAborted();
  const read = await readSourceToGrid(source, ctx.grid, {
    signal: params.signal,
    samples,
    maxPixels: params.maxPixels ?? DEFAULT_MAX_PIXELS,
    what: `Band "${key}"`,
  });
  params.signal?.throwIfAborted();
  return read;
}

function percentText(x: number): string {
  if (x > 0 && x < 0.01) return "less than 1%";
  return `${Math.floor(x * 100)}%`;
}

type Counts = { total: number; covered: number; clear: number; valid: number };

function assess(
  counts: Counts,
  opts: { sceneCloudCover: number | null; gsdM: number; minValidFraction: number; downsampled: boolean; clearWord: string },
): { status: AnalysisStatus; quality: ObservationQuality; validFraction: number } {
  const { total, covered, clear, valid } = counts;
  const coverage = total > 0 ? covered / total : 0;
  const masked = total > 0 ? (total - clear) / total : 1;
  const validFraction = total > 0 ? valid / total : 0;
  const flags: string[] = [];
  if (coverage < PARTIAL_COVERAGE_BELOW) flags.push("partial_coverage");
  if (masked > HIGH_MASK_ABOVE) flags.push("high_mask_fraction");
  if (validFraction < opts.minValidFraction) flags.push("below_min_valid_fraction");
  if (opts.downsampled) flags.push("downsampled");
  const quality: ObservationQuality = {
    coverage_fraction: coverage,
    scene_cloud_cover: opts.sceneCloudCover,
    masked_fraction: masked,
    flags,
    gsd_m: opts.gsdM,
  };
  const min = `${Math.round(opts.minValidFraction * 100)}%`;
  let status: AnalysisStatus = "valid";
  if (covered === 0) {
    status = "unusable";
    quality.unusable_reason = "This image does not cover the area of interest.";
  } else if (valid === 0 || validFraction < opts.minValidFraction) {
    status = "unusable";
    quality.unusable_reason =
      coverage < opts.minValidFraction
        ? `This image covers only ${percentText(coverage)} of the area (minimum ${min} usable).`
        : validFraction < 0.01
          ? `Less than 1% of the area was ${opts.clearWord} in this image (minimum ${min}).`
          : `Only ${percentText(validFraction)} of the area was ${opts.clearWord} in this image (minimum ${min}).`;
  }
  return { status, quality, validFraction };
}

function sumArea(mask: Uint8Array, grid: Grid): number {
  const rowArea = rowAreasM2(grid);
  let area = 0;
  for (let r = 0; r < grid.height; r++) {
    let n = 0;
    const start = r * grid.width;
    for (let c = 0; c < grid.width; c++) n += mask[start + c]!;
    area += n * rowArea[r]!;
  }
  return area;
}

function countFinite(values: Float32Array): number {
  let n = 0;
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i]!)) n++;
  return n;
}

// ── Optical ───────────────────────────────────────────────────

export type OpticalCollection = "sentinel-2-l2a" | "landsat-c2-l2";

type OpticalBands = { red: string; nir: string; green: string; blue: string; nir08: string; swir16: string; quality: string; visual: string | null };

/** Canonical asset keys per collection (ORYN NormalizedAsset.assets keys). */
export const OPTICAL_BANDS: Record<OpticalCollection, OpticalBands> = {
  // NDMI uses the narrow NIR band and SWIR1: Sentinel-2 B8A/B11 (both 20 m), Landsat SR_B5/SR_B6 (30 m).
  "sentinel-2-l2a": { red: "red", nir: "nir", green: "green", blue: "blue", nir08: "nir08", swir16: "swir16", quality: "scl", visual: "visual" },
  "landsat-c2-l2": { red: "red", nir: "nir08", green: "green", blue: "blue", nir08: "nir08", swir16: "swir16", quality: "qa_pixel", visual: null },
};

export type AnalyzeOpticalParams = CommonParams & {
  collection: OpticalCollection;
  /** Provider-reported scene cloud cover (%), copied into quality. */
  sceneCloudCover: number | null;
  /**
   * ndmi must be requested on its own: it is computed on the grid of its own
   * bands (Sentinel-2 20 m, Landsat 30 m), never on the 10 m NDVI grid with
   * duplicated pixels.
   */
  want: { ndvi: boolean; ndwi: boolean; trueColor: boolean; ndmi?: boolean };
  /** Sentinel-2 only: also accept SCL class 7 (unclassified). Default false. */
  includeUnclassified?: boolean;
  /**
   * Sentinel-2 only: the provider has already applied the L2A BOA_ADD_OFFSET
   * to the pixel values (Earth Search item property
   * `earthsearch:boa_offset_applied`). Such Earth Search items still publish
   * raster:bands offset −0.1, but their DNs are already harmonized — verified
   * 2026-10-15: the same acquisition (S2A_18STE_20211101) has the same DNs at
   * baseline 03.01 (offset 0) and 05.00 (boa_offset_applied) — so the offset
   * must not be applied a second time. When true, reflectance offsets are
   * forced to 0 and the outputs carry the flag "reflectance_offset_overridden".
   * If the flag is wrongly omitted, the plausibility check below fails loudly.
   */
  boaOffsetApplied?: boolean;
};

export type OpticalResult = GridContext & {
  /** AOI pixels with data in every reflectance band read (or in the visual asset when only it was read) / AOI pixels. */
  coverageFraction: number;
  /** Quality-mask exclusions inside the AOI, by reason (pixels). */
  maskReasons: Record<string, number>;
  ndvi?: AnalysisOutput<NdviMetrics>;
  /** Same metric shape as NDVI (index statistics over the AOI's valid pixels). */
  ndmi?: AnalysisOutput<NdviMetrics>;
  ndwi?: AnalysisOutput<WaterMetrics> & { waterMask: Uint8Array };
  trueColor?: { png: Buffer; legend: Legend };
};

type LoadedBand = { read: GridRead; scaling: BandScaling; hasData: Uint8Array };

/** Share of clear pixels allowed below IMPLAUSIBLE_REFLECTANCE_BELOW before the scaling is rejected. */
const MAX_IMPLAUSIBLE_SHARE = 0.1;
const MIN_PIXELS_FOR_PLAUSIBILITY = 50;

/**
 * Refuse to compute indices when the scale/offset cannot be right: more than
 * 10 % of clear pixels (quality mask passed) below −0.02 reflectance. Correct
 * L2A/L2 data never comes close; a doubly-applied BOA offset (−0.1) pushes
 * most vegetation red values there.
 */
function assertPlausibleReflectance(band: LoadedBand, clear: Uint8Array, key: string): void {
  const { checked, below } = implausibleReflectanceCount(band.read.values, band.scaling, andMasks(band.hasData, clear));
  if (checked >= MIN_PIXELS_FOR_PLAUSIBILITY && below > MAX_IMPLAUSIBLE_SHARE * checked) {
    throw new InvalidInputError(
      "implausible_reflectance",
      `Band "${key}": ${Math.round((100 * below) / checked)}% of clear pixels have reflectance below ${IMPLAUSIBLE_REFLECTANCE_BELOW} ` +
        `after applying scale ${band.scaling.scale} and offset ${band.scaling.offset}. The published scale/offset does not match the pixel values ` +
        "(for example, a BOA offset that the provider already applied); indices were not computed.",
    );
  }
}

export async function analyzeOptical(params: AnalyzeOpticalParams): Promise<OpticalResult> {
  const { collection, want, assets } = params;
  const keys = OPTICAL_BANDS[collection];
  if (!keys) throw new InvalidInputError("unsupported_collection", `Optical analysis does not support collection "${String(collection)}".`);
  if (!want.ndvi && !want.ndwi && !want.trueColor && !want.ndmi) throw new InvalidInputError("nothing_requested", "No optical product was requested.");
  if (want.ndmi && (want.ndvi || want.ndwi || want.trueColor)) {
    throw new InvalidInputError(
      "separate_grid_required",
      "NDMI is computed on the native grid of its own bands (Sentinel-2 20 m, Landsat 30 m); request it in a separate call from NDVI, NDWI, and true colour.",
    );
  }
  if (want.ndwi && collection !== "sentinel-2-l2a") {
    throw new InvalidInputError("unsupported_product", "NDWI (analytic ndwi 1.0.0) is defined for Sentinel-2 L2A only.");
  }
  const minValid = params.minValidFraction ?? DEFAULT_MIN_VALID_FRACTION;
  const maxPixels = params.maxPixels ?? DEFAULT_MAX_PIXELS;
  const useVisual = want.trueColor && keys.visual !== null && assets[keys.visual] !== undefined;

  // Reflectance bands needed, in read order.
  const needed = new Set<string>();
  const add = (...ks: string[]) => ks.forEach((k) => needed.add(k));
  if (want.ndvi) add(keys.nir, keys.red);
  if (want.ndwi) add(keys.green, keys.nir);
  if (want.trueColor && !useVisual) add(keys.red, keys.green, keys.blue);
  if (want.ndmi) add(keys.nir08, keys.swir16);
  const analysing = Boolean(want.ndvi || want.ndwi || want.ndmi);
  for (const k of needed) requireAsset(assets, k, "this optical product");
  if (analysing) requireAsset(assets, keys.quality, "cloud masking");

  const sources = new Map<string, RasterSource>();
  for (const k of needed) sources.set(k, await openAsset(params, k));
  const visualSource = useVisual ? await openAsset(params, keys.visual!) : null;

  // Lattice: the finest reflectance band (or the visual asset when that is all we read).
  const candidates = [...sources.values(), ...(visualSource ? [visualSource] : [])];
  const lattice = candidates.reduce((best, s) => (s.info.levels[0]!.pixelW < best.info.levels[0]!.pixelW ? s : best));
  const ctx = buildGridContext(params.aoi, lattice, maxPixels);
  const { grid, inside } = ctx;

  const bands = new Map<string, LoadedBand>();
  let downsampled = false;
  let offsetOverridden = false;
  for (const [k, src] of sources) {
    const read = await readBand(params, src, ctx, k);
    downsampled ||= read.downsampled;
    let scaling = bandScaling(assets[k]!.bands?.[0], read.nodata, { requireScale: true, label: `Band "${k}"` });
    if (collection === "sentinel-2-l2a" && params.boaOffsetApplied && scaling.offset !== 0) {
      scaling = { ...scaling, offset: 0 };
      offsetOverridden = true;
    }
    bands.set(k, { read, scaling, hasData: dataMask(read.values, scaling.nodata, read.footprint, inside) });
  }
  const coveredAll = andMasks(...[...bands.values()].map((b) => b.hasData));
  const result: OpticalResult = {
    ...ctx,
    coverageFraction: bands.size > 0 ? countOnes(coveredAll) / ctx.insideCount : 0,
    maskReasons: {},
  };

  let qualityMask: MaskResult | null = null;
  if (analysing) {
    const qSrc = await openAsset(params, keys.quality);
    const q = await readBand(params, qSrc, ctx, keys.quality);
    downsampled ||= q.downsampled;
    qualityMask =
      collection === "sentinel-2-l2a"
        ? sclValidMask(q.values, { inside, footprint: q.footprint, includeUnclassified: params.includeUnclassified })
        : landsatQaValidMask(q.values, { inside, footprint: q.footprint });
    result.maskReasons = qualityMask.reasons;
    const analysed = new Set<string>([
      ...(want.ndvi ? [keys.nir, keys.red] : []),
      ...(want.ndwi ? [keys.green, keys.nir] : []),
      ...(want.ndmi ? [keys.nir08, keys.swir16] : []),
    ]);
    for (const k of analysed) assertPlausibleReflectance(bands.get(k)!, qualityMask.valid, k);
  }

  const gsdM = nominalGsdM(grid);
  const clearWord = "cloud-free";
  const index = (aKey: string, bKey: string) => {
    const a = bands.get(aKey)!;
    const b = bands.get(bKey)!;
    const covered = andMasks(a.hasData, b.hasData);
    const clear = andMasks(covered, qualityMask!.valid);
    const values = normalizedDifference(a.read.values, a.scaling, b.read.values, b.scaling, clear);
    const counts: Counts = { total: ctx.insideCount, covered: countOnes(covered), clear: countOnes(clear), valid: countFinite(values) };
    const assessed = assess(counts, { sceneCloudCover: params.sceneCloudCover, gsdM, minValidFraction: minValid, downsampled, clearWord });
    if (offsetOverridden) assessed.quality.flags.push("reflectance_offset_overridden");
    return { values, counts, ...assessed };
  };

  /** Index statistics over the AOI's valid pixels (NDVI, NDMI); null metrics when unusable. */
  const indexOutput = (r: ReturnType<typeof index>, kind: "ndvi" | "ndmi"): AnalysisOutput<NdviMetrics> => {
    const stats = r.status === "valid" ? summarize(r.values) : null;
    const rendered = renderContinuous(r.values, grid.width, grid.height, inside, kind);
    return {
      status: stats ? r.status : "unusable",
      metrics: stats
        ? {
            mean: stats.mean,
            median: stats.median,
            p10: stats.p10,
            p90: stats.p90,
            std: stats.std,
            min: stats.min,
            max: stats.max,
            valid_pixels: r.counts.valid,
            total_pixels: r.counts.total,
            valid_fraction: r.validFraction,
            masked_fraction: r.quality.masked_fraction,
            pixel_area_m2: nominalPixelAreaM2(grid),
            histogram: histogram(r.values, null, -1, 1, 20),
          }
        : null,
      quality: r.quality,
      values: r.values,
      ...rendered,
    };
  };

  if (want.ndvi) result.ndvi = indexOutput(index(keys.nir, keys.red), "ndvi");
  // NDMI (Gao 1996) = (NIR − SWIR1) / (NIR + SWIR1)
  if (want.ndmi) result.ndmi = indexOutput(index(keys.nir08, keys.swir16), "ndmi");

  if (want.ndwi) {
    const r = index(keys.green, keys.nir);
    const waterMask = aboveThreshold(r.values, NDWI_WATER_THRESHOLD);
    const water = countOnes(waterMask);
    const meanIndex = meanOf(r.values);
    const usable = r.status === "valid" && r.counts.valid > 0;
    const rendered = renderContinuous(r.values, grid.width, grid.height, inside, "ndwi");
    result.ndwi = {
      status: usable ? "valid" : "unusable",
      metrics: usable
        ? {
            water_fraction: water / r.counts.valid,
            water_area_m2: sumArea(waterMask, grid),
            valid_fraction: r.validFraction,
            valid_pixels: r.counts.valid,
            total_pixels: r.counts.total,
            pixel_area_m2: nominalPixelAreaM2(grid),
            threshold: NDWI_WATER_THRESHOLD,
            ...(meanIndex === null ? {} : { mean_index: meanIndex }),
          }
        : null,
      quality: r.quality,
      values: r.values,
      waterMask,
      ...rendered,
    };
  }

  if (want.trueColor) {
    if (visualSource) {
      const read = await readBand(params, visualSource, ctx, keys.visual!, [0, 1, 2]);
      const nodata = assets[keys.visual!]!.bands?.[0]?.nodata ?? read.nodata ?? 0;
      const hasData = new Uint8Array(inside.length);
      const [r, g, b] = read.bands as [TypedArray, TypedArray, TypedArray];
      for (let i = 0; i < inside.length; i++) {
        if (inside[i] && read.footprint[i] && !(r[i] === nodata && g[i] === nodata && b[i] === nodata)) hasData[i] = 1;
      }
      result.trueColor = renderTrueColor([r, g, b], grid.width, grid.height, inside, hasData, { mode: "direct8bit" });
      if (bands.size === 0) result.coverageFraction = countOnes(hasData) / ctx.insideCount;
    } else {
      const rgb = [keys.red, keys.green, keys.blue].map((k) => bands.get(k)!) as [LoadedBand, LoadedBand, LoadedBand];
      result.trueColor = renderTrueColor(
        [rgb[0].read.values, rgb[1].read.values, rgb[2].read.values],
        grid.width,
        grid.height,
        inside,
        andMasks(rgb[0].hasData, rgb[1].hasData, rgb[2].hasData),
        { mode: "stretch", scaling: [rgb[0].scaling, rgb[1].scaling, rgb[2].scaling] },
      );
    }
  }
  return result;
}

// ── Sentinel-1 water ──────────────────────────────────────────

export type AnalyzeS1WaterParams = CommonParams & {
  /** VV backscatter threshold in dB (default −18). */
  thresholdDb?: number;
};

export type S1WaterResult = AnalysisOutput<WaterMetrics> &
  GridContext & {
    /** 1 = open-water candidate (valid and VV dB < threshold). */
    waterMask: Uint8Array;
    /** 1 = valid backscatter inside the AOI. */
    valid: Uint8Array;
  };

export async function analyzeS1Water(params: AnalyzeS1WaterParams): Promise<S1WaterResult> {
  const threshold = params.thresholdDb ?? S1_WATER_THRESHOLD_DB;
  if (!Number.isFinite(threshold)) throw new InvalidInputError("invalid_threshold", "thresholdDb must be finite.");
  const asset = requireAsset(params.assets, "vv", "Sentinel-1 water detection");
  const src = await openAsset(params, "vv");
  const ctx = buildGridContext(params.aoi, src, params.maxPixels ?? DEFAULT_MAX_PIXELS);
  const { grid, inside } = ctx;
  const read = await readBand(params, src, ctx, "vv");
  const band = asset.bands?.[0];
  const nodata = band && band.nodata !== undefined ? band.nodata : read.nodata;
  const mask = s1ValidMask(read.values, nodata ?? null, { inside, footprint: read.footprint });
  const db = linearToDb(read.values, nodata ?? null, mask.valid);
  const waterMask = belowThreshold(db, threshold);
  const water = countOnes(waterMask);
  const counts: Counts = {
    total: ctx.insideCount,
    covered: ctx.insideCount - (mask.reasons.no_data ?? 0),
    clear: mask.validCount,
    valid: countFinite(db),
  };
  const a = assess(counts, {
    sceneCloudCover: null,
    gsdM: nominalGsdM(grid),
    minValidFraction: params.minValidFraction ?? DEFAULT_MIN_VALID_FRACTION,
    downsampled: read.downsampled,
    clearWord: "covered by valid radar backscatter",
  });
  const meanDb = meanOf(db);
  const usable = a.status === "valid" && counts.valid > 0;
  return {
    ...ctx,
    status: usable ? "valid" : "unusable",
    metrics: usable
      ? {
          water_fraction: water / counts.valid,
          water_area_m2: sumArea(waterMask, grid),
          valid_fraction: a.validFraction,
          valid_pixels: counts.valid,
          total_pixels: counts.total,
          pixel_area_m2: nominalPixelAreaM2(grid),
          threshold,
          ...(meanDb === null ? {} : { mean_vv_db: meanDb }),
        }
      : null,
    quality: a.quality,
    values: db,
    waterMask,
    valid: mask.valid,
    ...renderWaterMask(waterMask, mask.valid, grid.width, grid.height, inside),
  };
}

// ── Land cover ────────────────────────────────────────────────

export type AnalyzeLandcoverParams = CommonParams & { collection: LandcoverProduct };

export type LandcoverResult = AnalysisOutput<LandcoverMetrics> &
  GridContext & {
    /** Class codes as read (all pixels of the grid). */
    codes: TypedArray;
    /** Codes the product table does not define, if any appeared inside the AOI. */
    unknownCodes: number[];
  };

export async function analyzeLandcover(params: AnalyzeLandcoverParams): Promise<LandcoverResult> {
  const table = LANDCOVER_TABLES[params.collection];
  if (!table) throw new InvalidInputError("unsupported_collection", `Land-cover analysis does not support "${String(params.collection)}".`);
  const asset = requireAsset(params.assets, table.assetKey, "land-cover composition");
  const src = await openAsset(params, table.assetKey);
  const ctx = buildGridContext(params.aoi, src, params.maxPixels ?? DEFAULT_MAX_PIXELS);
  const { grid, inside } = ctx;
  const read = await readBand(params, src, ctx, table.assetKey);
  const band = asset.bands?.[0];
  const nodata = band && band.nodata !== undefined && band.nodata !== null ? band.nodata : table.nodata;
  const comp = composition(read.values, inside, grid, nodata === table.nodata ? table : { ...table, nodata }, read.footprint);
  const counts: Counts = {
    total: comp.totalPixels,
    covered: comp.totalPixels - comp.noDataPixels,
    clear: comp.validPixels,
    valid: comp.validPixels,
  };
  const a = assess(counts, {
    sceneCloudCover: null,
    gsdM: nominalGsdM(grid),
    minValidFraction: params.minValidFraction ?? DEFAULT_MIN_VALID_FRACTION,
    downsampled: read.downsampled,
    clearWord: "classified with land-cover information",
  });
  if (comp.unknownPixels > 0) a.quality.flags.push("unknown_class_codes");
  if (comp.nonLandCoverPixels > 0) a.quality.flags.push("provider_cloud_class");
  const values = new Float32Array(read.values.length).fill(Number.NaN);
  for (let i = 0; i < values.length; i++) if (comp.valid[i]) values[i] = read.values[i]!;
  return {
    ...ctx,
    status: a.status,
    metrics: a.status === "valid" ? comp.metrics : null,
    quality: a.quality,
    values,
    codes: read.values,
    unknownCodes: comp.unknownCodes,
    ...renderLandcover(read.values, comp.valid, grid.width, grid.height, inside, table),
  };
}
