/**
 * Client-side shapes of API responses. Server types are reused with dates
 * turned into ISO strings (what JSON delivers).
 */
import type { AoiDetail } from "@/server/aois/service";
import type { AoiAssetView, DetectionDetail, ObservationView } from "@/server/results/service";

export type Jsonify<T> = T extends Date
  ? string
  : T extends readonly unknown[]
    ? { [K in keyof T]: Jsonify<T[K]> } // preserves tuples like [lon, lat]
    : T extends object
      ? { [K in keyof T]: Jsonify<T[K]> }
      : T;

export type Aoi = Jsonify<AoiDetail>;
export type Observation = Jsonify<ObservationView>;
export type AoiAsset = Jsonify<AoiAssetView>;
export type Detection = Jsonify<DetectionDetail>;

export type AoiFeatureProps = {
  id: string;
  name: string;
  kind: string;
  status: string;
  area_m2: number;
  parent_id: string | null;
  is_synthetic: boolean;
  monitoring: boolean;
  last_checked_at: string | null;
  open_alerts: number;
  unreviewed_detections: number;
};

export type DetectionFeatureProps = {
  id: string;
  aoi_id: string;
  aoi_name: string;
  type: string;
  title: string;
  result_class: string;
  area_m2: number | null;
  evidence_grade: string;
  verification_status: string;
  baseline_observed_at: string | null;
  comparison_observed_at: string | null;
  mean_delta: number | null;
  model: string;
};

export type FC<P> = { type: "FeatureCollection"; features: { type: "Feature"; id?: string | number; geometry: GeoJSON.Geometry; properties: P }[] };

export type WeatherRow = { provider_id: string; record_kind: "observation" | "forecast" | "model_estimate"; variable: string; value: number | null; unit: string; valid_from: string; valid_to: string; issued_at: string | null };
export type AoiContext = {
  weather: WeatherRow[];
  warnings: { id: string; provider_id: string; title: string; description: string | null; severity: string | null; certainty: string | null; urgency: string | null; event_start: string | null; event_end: string | null; published_at: string | null; source_url: string | null; claim_status: string; active: boolean }[];
  /** Server time when the context was read (ISO); all "last N days" windows are relative to it. */
  now: string;
  news: { article_id: string; title: string; url: string; domain: string | null; published_at: string | null; category: string; location_match: string; story_key: string; independent_sources: number }[];
};
