/**
 * Report content snapshot (reports.content).
 *
 * A report is assembled once from STORED data and frozen here; the PDF and
 * any later re-rendering use only this snapshot. Every number in the
 * snapshot carries an evidence id (E…) that resolves, through `evidence`,
 * to the source table and row ids it came from. Limitations carry L… ids.
 */

export const REPORT_TYPES = ["field", "aoi", "change", "weather", "municipal", "disaster", "processing", "audit"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_TYPE_LABEL: Record<ReportType, string> = {
  field: "Field report",
  aoi: "Area of interest report",
  change: "Change report",
  weather: "Weather report",
  municipal: "Municipal monitoring report",
  disaster: "Disaster situation report",
  processing: "Processing history report",
  audit: "Audit trail report",
};

export type ReportSectionKey = "observations" | "detections" | "weather" | "warnings" | "news" | "alerts" | "processing" | "audit";

/** Sections included per report type (sources, limitations, and evidence are always included). */
export const REPORT_SECTIONS: Record<ReportType, ReportSectionKey[]> = {
  field: ["observations", "detections", "weather", "warnings", "alerts", "processing"],
  aoi: ["observations", "detections", "weather", "warnings", "news", "alerts", "processing"],
  change: ["observations", "detections", "alerts", "processing"],
  weather: ["weather", "warnings", "alerts"],
  municipal: ["observations", "detections", "weather", "warnings", "news", "alerts"],
  disaster: ["warnings", "news", "observations", "detections", "weather", "alerts"],
  processing: ["processing", "observations"],
  audit: ["audit"],
};

/** Report types that need an AOI (the others may cover the whole organization). */
export const AOI_REQUIRED: Record<ReportType, boolean> = {
  field: true,
  aoi: true,
  change: true,
  weather: true,
  municipal: true,
  disaster: true,
  processing: false,
  audit: false,
};

export type DataStatus = "ok" | "missing" | "stale" | "partial";

/** A plain-language statement about a section's data (always present, especially when data is missing or stale). */
export type SectionStatement = { status: DataStatus; text: string };

export type EvidenceKind =
  | "aoi"
  | "observation"
  | "detection"
  | "weather"
  | "warning"
  | "news"
  | "alert"
  | "processing_run"
  | "source_asset"
  | "audit"
  | "limitation";

export type EvidenceEntry = {
  id: string;
  kind: EvidenceKind;
  /** Source table; null for limitations from the analytic registry. */
  table: string | null;
  row_ids: string[];
  label: string;
};

export type RasterSummary = {
  png_key: string;
  corners: [[number, number], [number, number], [number, number], [number, number]];
  legend: { kind: string; min?: number; max?: number; stops?: { value: number; color: string; label?: string }[] };
  width: number;
  height: number;
  epsg: number;
};

export type ObservationEntry = {
  evidence_id: string;
  observation_id: string;
  kind: string;
  model_id: string;
  model_version: string;
  result_class: string;
  provider_id: string;
  collection: string;
  platform: string | null;
  asset_id: string;
  observed_at: string;
  processed_at: string;
  status: "valid" | "unusable";
  unusable_reason: string | null;
  is_current: boolean;
  /** Scalar metrics only (mean, median, p10, p90, valid_fraction, water_area_m2, …). */
  metrics: Record<string, number>;
  quality: { coverage_fraction: number | null; masked_fraction: number | null; scene_cloud_cover: number | null; flags: string[] };
  raster: RasterSummary | null;
};

export type DetectionEntry = {
  evidence_id: string;
  detection_id: string;
  type: string;
  title: string;
  result_class: string;
  area_m2: number | null;
  model_id: string | null;
  model_version: string | null;
  baseline_observed_at: string | null;
  comparison_observed_at: string | null;
  created_at: string;
  evidence_grade: string;
  evidence_reasons: string[];
  verification_status: string;
  direction: string | null;
  mean_delta: number | null;
};

export type WeatherKind = "observation" | "model_estimate" | "forecast";

export type WeatherVariableSummary = {
  evidence_id: string;
  variable: string;
  label: string;
  unit: string;
  records: number;
  days: number;
  from: string;
  to: string;
  providers: string[];
  /** Sum of daily totals (precipitation, ET0). */
  total: number | null;
  min: number | null;
  max: number | null;
  mean: number | null;
  /** For forecasts: when the newest included forecast was issued. */
  issued_at: string | null;
  latest_retrieved_at: string;
};

export type WeatherKindSummary = {
  record_kind: WeatherKind;
  label: string;
  caveat: string;
  statement: SectionStatement;
  variables: WeatherVariableSummary[];
};

export type WarningEntry = {
  evidence_id: string;
  warning_id: string;
  provider_id: string;
  title: string;
  severity: string | null;
  certainty: string | null;
  urgency: string | null;
  event_start: string | null;
  event_end: string | null;
  published_at: string | null;
  source_url: string | null;
  claim_status: string;
};

export type NewsStory = {
  evidence_id: string;
  story_key: string;
  title: string;
  category: string;
  first_published_at: string | null;
  articles: { article_id: string; title: string; domain: string | null; url: string; published_at: string | null; location_match: string }[];
  /** Distinct publishing domains reporting this story. */
  independent_sources: number;
};

export type ReportedEventEntry = {
  evidence_id: string;
  event_id: string;
  provider_id: string;
  title: string;
  published_at: string | null;
  source_url: string | null;
  claim_status: string;
};

export type AlertEntry = {
  evidence_id: string;
  alert_id: string;
  title: string;
  severity: string;
  status: string;
  basis: string | null;
  observed_at: string | null;
  created_at: string;
  from_reprocessing: boolean;
};

export type ProcessingRunEntry = {
  evidence_id: string;
  run_id: string;
  aoi_id: string;
  model_id: string;
  model_version: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  input_asset_ids: string[];
  messages: string[];
  error: string | null;
  software_version: string;
};

export type SourceAssetEntry = {
  evidence_id: string;
  asset_id: string;
  provider_id: string;
  collection: string;
  external_id: string;
  platform: string | null;
  acquired_at: string;
  cloud_cover: number | null;
  license: string | null;
  license_url: string | null;
  attribution: string | null;
  stac_url: string | null;
};

export type ModelLimitation = {
  model_id: string;
  model_version: string;
  name: string;
  result_class: string;
  limitations: { id: string; text: string }[];
};

export type AuditEntry = {
  id: string;
  created_at: string;
  actor_type: string;
  actor_label: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
};

export type Finding = { id: string; section: string; text: string; evidence_ids: string[] };

export type ReportSummary = {
  /** 'template', 'ai:<model>', or 'template (ai_unavailable: <reason>)'. */
  method: string;
  /** Deterministic narrative built from findings (always present). */
  template: string;
  /** Validated AI narrative, when one was produced. */
  ai: { model: string; sentences: { text: string; evidence_ids: string[] }[]; dropped_sentences: number } | null;
  /** The narrative to display: the AI narrative when available, otherwise the template. */
  text: string;
};

export type ReportContent = {
  schema_version: 1;
  report: { id: string; type: ReportType; title: string; generated_at: string; period: { from: string; to: string }; params: Record<string, unknown> };
  org: { id: string; name: string; slug: string; kind: string; is_synthetic: boolean };
  aoi: {
    id: string;
    name: string;
    kind: string;
    status: string;
    area_m2: number;
    area_text: string;
    centroid: [number, number] | null;
    bbox: [number, number, number, number] | null;
    geometry: { type: string; coordinates: unknown } | null;
    boundary_source: Record<string, unknown>;
    is_synthetic: boolean;
    created_at: string;
    evidence_id: string;
  } | null;
  data_currency: {
    status: DataStatus;
    statement: string;
    latest_usable_observation_at: string | null;
    latest_usable_age_days: number | null;
    latest_processed_at: string | null;
    latest_weather_retrieved_at: string | null;
  };
  sections: ReportSectionKey[];
  observations: {
    statement: SectionStatement;
    series: ObservationEntry[];
    latest: ObservationEntry | null;
    unusable_count: number;
    by_kind: { kind: string; valid: number; unusable: number; latest_valid_at: string | null }[];
  } | null;
  detections: { statement: SectionStatement; items: DetectionEntry[] } | null;
  weather: { statement: SectionStatement; kinds: WeatherKindSummary[] } | null;
  warnings: { statement: SectionStatement; items: WarningEntry[] } | null;
  news: { statement: SectionStatement; note: string; stories: NewsStory[]; reported_events: ReportedEventEntry[] } | null;
  alerts: { statement: SectionStatement; open: AlertEntry[] } | null;
  processing: { statement: SectionStatement; runs: ProcessingRunEntry[] } | null;
  audit: { statement: SectionStatement; events: AuditEntry[]; by_action: Record<string, number> } | null;
  sources: { assets: SourceAssetEntry[]; weather_providers: string[]; news_providers: string[]; attributions: string[] };
  limitations: { models: ModelLimitation[]; general: { id: string; text: string }[] };
  findings: Finding[];
  evidence: Record<string, EvidenceEntry>;
  summary: ReportSummary | null;
};
