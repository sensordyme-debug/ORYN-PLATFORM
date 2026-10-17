/**
 * Alert explanations: the structured "what / where / why / evidence /
 * certainty / suggested action / limitations" record stored in
 * alerts.explanation and rendered in the UI, emails, and reports.
 *
 * Guarantees
 *  - Every explanation names the kind of data it rests on (observation,
 *    model estimate, forecast, official warning, candidate change, data gap)
 *    so those are never conflated in any message.
 *  - Certainty is plain language derived from evidence grades and recorded
 *    data quality. No numeric confidence is ever invented.
 *  - Limitations come from the analytic registry for every model involved,
 *    plus data-specific caveats.
 */
import { ANALYTICS, type AnalyticId } from "@/server/analytics/registry";
import type { ObservationQuality } from "@/server/analytics/types";
import { formatArea, formatLatLon, type Position } from "@/lib/geo";

export type EvidenceType = "observation" | "detection" | "weather" | "warning" | "source_asset";

export type AlertEvidence = {
  type: EvidenceType;
  id: string;
  label: string;
  /** Acquisition / validity time of the evidence (ISO 8601), when it has one. */
  observed_at: string | null;
  /** All source row ids when one evidence item aggregates several rows (e.g. hourly weather records of one day). */
  ids?: string[];
};

/** What the alert rests on. Shown with every alert so data kinds are never conflated. */
export type AlertBasis =
  | "observation"
  | "model_estimate"
  | "forecast"
  | "official_warning"
  | "candidate_change"
  | "model_prediction"
  | "deterministic_calculation"
  | "data_gap";

export const BASIS_LABEL: Record<AlertBasis, string> = {
  observation: "Recorded observation",
  model_estimate: "Model estimate (not a direct measurement)",
  forecast: "Forecast (a prediction, not an observation)",
  official_warning: "Official warning issued by an agency",
  candidate_change: "Candidate change (requires review)",
  model_prediction: "Model prediction from satellite observations",
  deterministic_calculation: "Calculation from satellite observations",
  data_gap: "Data-coverage gap (not a field condition)",
};

export type AlertExplanation = {
  what: string;
  where: string;
  why: string;
  evidence: AlertEvidence[];
  certainty: string;
  suggested_action: string;
  limitations: string[];
  basis: AlertBasis;
  rule: { id: string; name: string; type: string; params: Record<string, unknown> };
  /** The actual values compared against the rule's thresholds. */
  values: Record<string, number | string | boolean | null>;
  /** Distinct clocks, ISO 8601. */
  times: { event_at: string | null; observed_at: string | null; ingested_at: string | null; processed_at: string | null };
  /** Set when the alert came from reprocessing data ORYN already had. */
  reprocessing?: string;
  /** Set when the alert was suppressed by the rule's cooldown. */
  suppressed_reason?: string;
};

export type ExplainAoi = { name: string; areaM2: number; centroid: Position | null };

export function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/** Calendar date (UTC) of a timestamp, YYYY-MM-DD. */
export function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** "2026-10-14 15:02 UTC" */
export function when(d: Date | null | undefined): string {
  if (!d) return "unknown";
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function num(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "n/a";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function pct(fraction: number | null | undefined): string {
  return typeof fraction === "number" && Number.isFinite(fraction) ? `${Math.round(fraction * 100)}%` : "unknown";
}

export function whereText(aoi: ExplainAoi): string {
  const centre = aoi.centroid ? `, centred near ${formatLatLon(aoi.centroid, 4)}` : "";
  return `${aoi.name} (${formatArea(aoi.areaM2)}${centre})`;
}

export function regionWhereText(aoi: ExplainAoi, region: { areaM2: number | null; centroid: Position | null }): string {
  const size = region.areaM2 != null ? `A ${formatArea(region.areaM2)} region` : "A region";
  const centre = region.centroid ? ` centred near ${formatLatLon(region.centroid, 4)}` : "";
  return `${size}${centre}, within ${whereText(aoi)}`;
}

/** Limitations documented for a model in the analytic registry (empty when unknown). */
export function registryLimitations(modelId: string | null | undefined): string[] {
  if (!modelId || !Object.prototype.hasOwnProperty.call(ANALYTICS, modelId)) return [];
  return [...ANALYTICS[modelId as AnalyticId].limitations];
}

/** Combine and de-duplicate limitation lists, always ending with the alert-rule limitation. */
export function mergeLimitations(...lists: (readonly string[] | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const l of [...lists, ANALYTICS["alert-rule"].limitations]) {
    for (const s of l ?? []) if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

const FLAG_TEXT: Record<string, string> = {
  partial_coverage: "the scene covers only part of the AOI",
  high_mask_fraction: "a large share of pixels was masked (cloud, shadow, or quality flags)",
  below_min_valid_fraction: "too few valid pixels",
};

/** Plain-language data-quality statement for an observation. */
export function qualityStatement(q: Partial<ObservationQuality> | null | undefined, metrics?: Record<string, unknown>): string {
  const parts: string[] = [];
  const valid = typeof metrics?.valid_fraction === "number" ? (metrics.valid_fraction as number) : null;
  if (valid != null) parts.push(`${pct(valid)} of AOI pixels were usable`);
  if (typeof q?.masked_fraction === "number") parts.push(`${pct(q.masked_fraction)} were masked as cloud, shadow, or no data`);
  if (typeof q?.coverage_fraction === "number") parts.push(`the scene covered ${pct(q.coverage_fraction)} of the AOI`);
  if (typeof q?.scene_cloud_cover === "number") parts.push(`the provider reports ${num(q.scene_cloud_cover, 1)}% scene cloud cover`);
  const flags = (q?.flags ?? []).map((f) => FLAG_TEXT[f] ?? f.replace(/_/g, " "));
  let s = parts.length ? `${capitalize(parts.join(", "))}.` : "Data-quality details were not recorded.";
  if (flags.length) s += ` Quality flags: ${flags.join("; ")}.`;
  return s;
}

const GRADE_TEXT: Record<string, string> = {
  strong: "The change model graded the evidence as strong",
  moderate: "The change model graded the evidence as moderate",
  weak: "The change model graded the evidence as weak",
  insufficient: "The change model graded the evidence as insufficient",
};

/** Plain-language certainty for a candidate change. Never a number. */
export function detectionCertainty(d: { evidenceGrade: string; evidenceReasons: string[]; verificationStatus: string }): string {
  const reasons = d.evidenceReasons.length ? ` (${d.evidenceReasons.join("; ")})` : "";
  const verification =
    d.verificationStatus === "confirmed"
      ? "A team member has confirmed it."
      : d.verificationStatus === "needs_field_check"
        ? "It has been marked as needing a field check."
        : "It has not been verified by a person.";
  return `${GRADE_TEXT[d.evidenceGrade] ?? `Evidence grade: ${d.evidenceGrade}`}${reasons}. This is a candidate change, not a confirmed real-world event. ${verification}`;
}

export const WEATHER_KIND_CAVEAT: Record<"observation" | "model_estimate" | "forecast", string> = {
  observation: "Station observations describe conditions at the station, which may differ from conditions across the AOI.",
  model_estimate:
    "Model estimates (e.g. reanalysis) are gridded model output, not direct measurements; local rainfall and temperature extremes are often smoothed out.",
  forecast: "Forecasts are predictions issued at a point in time; actual conditions may differ and later forecasts may change.",
};

export function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
