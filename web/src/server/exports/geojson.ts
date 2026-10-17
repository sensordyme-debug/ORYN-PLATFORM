/**
 * GeoJSON (RFC 7946) feature builders for exports.
 *
 * Guarantees
 *  - Coordinates are WGS 84 longitude/latitude, as RFC 7946 requires.
 *  - Every feature carries provenance: ORYN ids, the model id and version
 *    that produced it, result class, acquisition time (observed_at) and
 *    ORYN processing time (processed_at), evidence grade and verification
 *    status for detections, and source scene ids.
 *  - The collection carries an "oryn" foreign member with the export id,
 *    generation time, and licence/attribution notes for the source data.
 */

export type GeoJsonGeometry = { type: string; coordinates?: unknown; geometries?: unknown[] };

export type Feature = { type: "Feature"; id: string; geometry: GeoJsonGeometry | null; properties: Record<string, unknown> };

export type ExportMetadata = {
  export_id: string;
  org_id: string;
  subject: string;
  generated_at: string;
  license_notes: string[];
  notes: string[];
};

export type FeatureCollection = { type: "FeatureCollection"; features: Feature[]; oryn: ExportMetadata };

export const GEOJSON_CONTENT_TYPE = "application/geo+json";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export type DetectionExportRow = {
  id: string;
  aoi_id: string;
  aoi_name: string;
  type: string;
  result_class: string;
  title: string;
  geometry: GeoJsonGeometry | null;
  area_m2: number | null;
  model_id: string | null;
  model_version: string | null;
  run_id: string | null;
  baseline_observation_id: string | null;
  comparison_observation_id: string | null;
  baseline_observed_at: Date | null;
  comparison_observed_at: Date | null;
  first_observed_at: Date;
  last_observed_at: Date;
  created_at: Date;
  evidence_grade: string;
  evidence_reasons: string[];
  verification_status: string;
  verified_at: Date | null;
  source_asset_ids: string[];
  metrics: Record<string, unknown>;
  thresholds: Record<string, unknown>;
  limitations: string[];
};

export function detectionFeature(d: DetectionExportRow): Feature {
  return {
    type: "Feature",
    id: d.id,
    geometry: d.geometry,
    properties: {
      oryn_type: "detection",
      detection_id: d.id,
      aoi_id: d.aoi_id,
      aoi_name: d.aoi_name,
      detection_type: d.type,
      title: d.title,
      result_class: d.result_class,
      area_m2: d.area_m2,
      model_id: d.model_id,
      model_version: d.model_version,
      processing_run_id: d.run_id,
      baseline_observation_id: d.baseline_observation_id,
      comparison_observation_id: d.comparison_observation_id,
      baseline_observed_at: iso(d.baseline_observed_at),
      observed_at: iso(d.comparison_observed_at ?? d.last_observed_at),
      first_observed_at: iso(d.first_observed_at),
      last_observed_at: iso(d.last_observed_at),
      processed_at: iso(d.created_at),
      evidence_grade: d.evidence_grade,
      evidence_reasons: d.evidence_reasons,
      verification_status: d.verification_status,
      verified_at: iso(d.verified_at),
      source_asset_ids: d.source_asset_ids,
      metrics: d.metrics,
      thresholds: d.thresholds,
      limitations: d.limitations,
      note: d.result_class === "candidate_change" ? "Candidate change: not a confirmed real-world change unless verification_status is 'confirmed'." : null,
    },
  };
}

export type AoiExportRow = {
  id: string;
  name: string;
  kind: string;
  status: string;
  geometry: GeoJsonGeometry | null;
  area_m2: number;
  boundary_source: Record<string, unknown>;
  is_synthetic: boolean;
  tags: string[];
  created_at: Date;
  updated_at: Date;
};

export function aoiFeature(a: AoiExportRow): Feature {
  return {
    type: "Feature",
    id: a.id,
    geometry: a.geometry,
    properties: {
      oryn_type: "aoi",
      aoi_id: a.id,
      name: a.name,
      kind: a.kind,
      status: a.status,
      area_m2: a.area_m2,
      boundary_source: a.boundary_source,
      is_synthetic: a.is_synthetic,
      tags: a.tags,
      created_at: iso(a.created_at),
      updated_at: iso(a.updated_at),
    },
  };
}

export type ObservationExportRow = {
  id: string;
  aoi_id: string;
  aoi_name: string;
  geometry: GeoJsonGeometry | null;
  kind: string;
  model_id: string;
  model_version: string;
  result_class: string;
  status: string;
  observed_at: Date;
  processed_at: Date;
  is_current: boolean;
  run_id: string;
  asset_id: string;
  provider_id: string;
  collection: string;
  external_id: string;
  metrics: Record<string, unknown>;
  quality: Record<string, unknown>;
  limitations: string[];
};

export function observationFeature(o: ObservationExportRow): Feature {
  // Histograms are bulky and not useful in a feature; everything else (incl. land-cover classes) is kept.
  const metrics = Object.fromEntries(Object.entries(o.metrics).filter(([k]) => k !== "histogram"));
  return {
    type: "Feature",
    id: o.id,
    geometry: o.geometry,
    properties: {
      oryn_type: "observation",
      observation_id: o.id,
      aoi_id: o.aoi_id,
      aoi_name: o.aoi_name,
      geometry_note: "Geometry is the AOI the observation summarizes, not the scene footprint.",
      kind: o.kind,
      model_id: o.model_id,
      model_version: o.model_version,
      result_class: o.result_class,
      status: o.status,
      unusable_reason: (o.quality.unusable_reason as string | undefined) ?? null,
      observed_at: iso(o.observed_at),
      processed_at: iso(o.processed_at),
      is_current: o.is_current,
      processing_run_id: o.run_id,
      source_asset_id: o.asset_id,
      source_provider: o.provider_id,
      source_collection: o.collection,
      source_external_id: o.external_id,
      metrics,
      quality: o.quality,
      limitations: o.limitations,
    },
  };
}

export function featureCollection(features: Feature[], meta: ExportMetadata): FeatureCollection {
  return { type: "FeatureCollection", features, oryn: meta };
}
