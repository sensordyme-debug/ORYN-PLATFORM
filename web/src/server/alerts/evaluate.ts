/**
 * Pure alert-rule evaluation.
 *
 * Input: one rule plus the stored data for one AOI (loaded by pipeline.ts).
 * Output: alert candidates and evaluation notes. No I/O, no clock reads —
 * "now" comes from the database in the input — so results are reproducible
 * and unit-testable.
 *
 * Guarantees
 *  - Alerts come only from the configured rule and the stored rows passed in.
 *  - Missing or insufficient data yields NO candidate and an explanatory
 *    note (code "no_data" / "insufficient_data") for processing history.
 *  - Dedupe keys are derived from the underlying evidence ids / dates, so
 *    re-evaluating the same evidence yields the same key.
 *  - Observation, model-estimate, forecast, official-warning, and
 *    candidate-change evidence are kept distinct in every title and
 *    explanation; forecast-based alerts say "Forecast" in both.
 */
import { formatArea, type Position } from "@/lib/geo";
import type { ObservationQuality } from "@/server/analytics/types";
import {
  BASIS_LABEL,
  day,
  detectionCertainty,
  iso,
  mergeLimitations,
  num,
  pct,
  qualityStatement,
  regionWhereText,
  registryLimitations,
  WEATHER_KIND_CAVEAT,
  when,
  whereText,
  type AlertBasis,
  type AlertEvidence,
  type AlertExplanation,
  type ExplainAoi,
} from "@/server/alerts/explain";
import {
  gradeRank,
  safeRuleParams,
  warningSeverityRank,
  type RuleParams,
  type RuleTypeId,
  type Severity,
} from "@/server/alerts/rules";

const DAY_MS = 86_400_000;

// ── Input shapes ───────────────────────────────────────────────

export type WeatherKind = "observation" | "model_estimate" | "forecast";

export type EvalAoi = ExplainAoi & { id: string; createdAt: Date };

export type EvalRule = {
  id: string;
  name: string;
  ruleType: RuleTypeId;
  params: unknown;
  severity: Severity;
  createdAt: Date;
};

export type EvalObservation = {
  id: string;
  kind: string;
  modelId: string;
  modelVersion: string;
  resultClass: string;
  status: "valid" | "unusable";
  observedAt: Date;
  processedAt: Date;
  /** When ORYN first saw the source asset in the provider catalog. */
  ingestedAt: Date | null;
  assetId: string;
  providerId: string;
  collection: string;
  platform: string | null;
  metrics: Record<string, unknown>;
  quality: Partial<ObservationQuality>;
  limitations: string[];
};

export type EvalDetection = {
  id: string;
  type: string;
  resultClass: string;
  title: string;
  areaM2: number | null;
  centroid: Position | null;
  evidenceGrade: string;
  evidenceReasons: string[];
  verificationStatus: string;
  modelId: string | null;
  modelVersion: string | null;
  metrics: Record<string, unknown>;
  baselineObservationId: string | null;
  comparisonObservationId: string | null;
  baselineObservedAt: Date | null;
  comparisonObservedAt: Date | null;
  lastObservedAt: Date;
  sourceAssetIds: string[];
  limitations: string[];
  createdAt: Date;
  ingestedAt: Date | null;
};

export type EvalWeather = {
  id: string;
  providerId: string;
  recordKind: WeatherKind;
  variable: string;
  value: number | null;
  unit: string;
  validFrom: Date;
  validTo: Date;
  issuedAt: Date | null;
  retrievedAt: Date;
  stationId: string | null;
  stationDistanceKm: number | null;
};

export type EvalWarning = {
  id: string;
  providerId: string;
  title: string;
  severity: string | null;
  certainty: string | null;
  urgency: string | null;
  category: string | null;
  eventStart: Date | null;
  eventEnd: Date | null;
  publishedAt: Date | null;
  retrievedAt: Date;
  sourceUrl: string | null;
  claimStatus: string;
};

export type EvaluationData = {
  /** Evaluation time (database clock). */
  now: Date;
  aoi: EvalAoi;
  /** Current observations in the look-back window, newest first (valid and unusable). */
  observations: EvalObservation[];
  /** Latest valid current observation per kind, regardless of age. */
  latestValidByKind: EvalObservation[];
  detections: EvalDetection[];
  weather: EvalWeather[];
  /** Official warnings (external_events.event_kind = 'weather_warning'). */
  warnings: EvalWarning[];
};

// ── Output shapes ──────────────────────────────────────────────

export type GeomSource = { source: "aoi" } | { source: "detection"; detectionId: string };

export type AlertCandidate = {
  ruleId: string;
  ruleType: RuleTypeId;
  dedupeKey: string;
  severity: Severity;
  title: string;
  explanation: AlertExplanation;
  eventAt: Date | null;
  observedAt: Date | null;
  ingestedAt: Date | null;
  processedAt: Date | null;
  geom: GeomSource;
  detectionId: string | null;
  observationId: string | null;
  /**
   * Derived from imagery processing. Only these are checked against prior
   * alerts' acquisition times to recognise reprocessed (re-derived) results;
   * weather records and warnings are fetched, not re-derived.
   */
  imageryDerived: boolean;
};

export type EvaluationNoteCode = "no_data" | "insufficient_data" | "condition_not_met" | "invalid_params";

export type EvaluationNote = { ruleId: string; ruleType: RuleTypeId; code: EvaluationNoteCode; message: string };

export type RuleEvaluation = { candidates: AlertCandidate[]; notes: EvaluationNote[] };

// ── Entry point ────────────────────────────────────────────────

export function evaluateRule(rule: EvalRule, data: EvaluationData): RuleEvaluation {
  switch (rule.ruleType) {
    case "ndvi_drop_vs_baseline":
      return withParams(rule, "ndvi_drop_vs_baseline", (p) => ndviDropVsBaseline(rule, p, data));
    case "ndvi_below":
      return withParams(rule, "ndvi_below", (p) => ndviBelow(rule, p, data));
    case "detection_created":
      return withParams(rule, "detection_created", (p) => detectionCreated(rule, p, data));
    case "precipitation_total_above":
      return withParams(rule, "precipitation_total_above", (p) => precipitationTotalAbove(rule, p, data));
    case "dry_spell":
      return withParams(rule, "dry_spell", (p) => drySpell(rule, p, data));
    case "heat_stress":
      return withParams(rule, "heat_stress", (p) => heatStress(rule, p, data));
    case "nws_warning":
      return withParams(rule, "nws_warning", (p) => nwsWarning(rule, p, data));
    case "new_water_area":
      return withParams(rule, "new_water_area", (p) => newWaterArea(rule, p, data));
    case "stale_observations":
      return withParams(rule, "stale_observations", (p) => staleObservations(rule, p, data));
  }
}

function withParams<T extends RuleTypeId>(rule: EvalRule, type: T, fn: (p: RuleParams<T>) => RuleEvaluation): RuleEvaluation {
  const p = safeRuleParams(type, rule.params);
  if (!p) return noteOnly(rule, "invalid_params", `Stored parameters for rule "${rule.name}" are invalid; the rule was not evaluated.`);
  return fn(p);
}

// ── Helpers ────────────────────────────────────────────────────

function note(rule: EvalRule, code: EvaluationNoteCode, message: string): EvaluationNote {
  return { ruleId: rule.id, ruleType: rule.ruleType, code, message };
}

function noteOnly(rule: EvalRule, code: EvaluationNoteCode, message: string): RuleEvaluation {
  return { candidates: [], notes: [note(rule, code, message)] };
}

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export function addDays(dayStr: string, n: number): string {
  const [y, m, d] = dayStr.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

function sourceLabel(o: EvalObservation): string {
  return o.platform ? `${o.platform} (${o.collection})` : o.collection;
}

function obsEvidence(o: EvalObservation, role: string): AlertEvidence {
  const m = finite(o.metrics.mean);
  const value = m != null ? `, mean ${num(m, 3)}` : "";
  return {
    type: "observation",
    id: o.id,
    label: `${role}: ${o.kind.toUpperCase()} ${o.modelId}@${o.modelVersion}, ${sourceLabel(o)} acquired ${day(o.observedAt)}${value}`,
    observed_at: iso(o.observedAt),
  };
}

function assetEvidence(o: EvalObservation): AlertEvidence {
  return { type: "source_asset", id: o.assetId, label: `Source scene ${o.collection} (${o.providerId})`, observed_at: iso(o.observedAt) };
}

function explanation(
  rule: EvalRule,
  params: Record<string, unknown>,
  e: Omit<AlertExplanation, "rule" | "times"> & {
    times: { event_at: Date | null; observed_at: Date | null; ingested_at: Date | null; processed_at: Date | null };
  },
): AlertExplanation {
  return {
    ...e,
    rule: { id: rule.id, name: rule.name, type: rule.ruleType, params },
    times: {
      event_at: iso(e.times.event_at),
      observed_at: iso(e.times.observed_at),
      ingested_at: iso(e.times.ingested_at),
      processed_at: iso(e.times.processed_at),
    },
  };
}

function candidate(
  rule: EvalRule,
  c: Omit<AlertCandidate, "ruleId" | "ruleType" | "severity">,
): AlertCandidate {
  return { ruleId: rule.id, ruleType: rule.ruleType, severity: rule.severity, ...c };
}

// ── NDVI ───────────────────────────────────────────────────────

function validNdvi(data: EvaluationData): (EvalObservation & { ndvi: number })[] {
  return data.observations
    .filter((o) => o.modelId === "ndvi" && o.status === "valid" && finite(o.metrics.mean) != null)
    .map((o) => ({ ...o, ndvi: o.metrics.mean as number }))
    .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime());
}

function ndviDropVsBaseline(rule: EvalRule, p: RuleParams<"ndvi_drop_vs_baseline">, data: EvaluationData): RuleEvaluation {
  const series = validNdvi(data);
  const latest = series[0];
  if (!latest) return noteOnly(rule, "no_data", `No valid NDVI observation is stored for ${data.aoi.name}; no alert raised.`);

  const from = latest.observedAt.getTime() - p.baseline_days * DAY_MS;
  const baseline = series.filter(
    (o) => o.id !== latest.id && o.collection === latest.collection && o.observedAt < latest.observedAt && o.observedAt.getTime() >= from,
  );
  if (baseline.length < p.min_baseline_n) {
    return noteOnly(
      rule,
      "insufficient_data",
      `Insufficient baseline: ${baseline.length} earlier valid NDVI observation(s) from ${latest.collection} in the ${p.baseline_days} days before ${day(latest.observedAt)}; the rule needs at least ${p.min_baseline_n}. No alert raised.`,
    );
  }
  const values = baseline.map((o) => o.ndvi);
  const baselineMean = mean(values);
  const spread = stdDev(values);
  const drop = baselineMean - latest.ndvi;
  if (drop + 1e-9 < p.min_drop) {
    return noteOnly(
      rule,
      "condition_not_met",
      `Latest NDVI ${num(latest.ndvi, 3)} vs. baseline ${num(baselineMean, 3)} (n=${baseline.length}): drop ${num(drop, 3)} < ${p.min_drop}.`,
    );
  }
  const oldest = baseline[baseline.length - 1]!;
  const newest = baseline[0]!;
  return {
    candidates: [
      candidate(rule, {
        dedupeKey: `ndvi_drop:${rule.id}:${latest.id}`,
        title: `NDVI ${num(drop, 2)} below baseline at ${data.aoi.name}`,
        explanation: explanation(rule, p, {
          what: `Mean NDVI over ${data.aoi.name} was ${num(latest.ndvi, 3)} in the ${sourceLabel(latest)} image acquired ${when(latest.observedAt)} — ${num(drop, 3)} lower than the AOI's own baseline mean of ${num(baselineMean, 3)}.`,
          where: whereText(data.aoi),
          why: `Rule "${rule.name}" fires when mean NDVI falls at least ${p.min_drop} below the mean of at least ${p.min_baseline_n} earlier valid observations from the same collection (${latest.collection}) within ${p.baseline_days} days. Actual: baseline ${num(baselineMean, 3)} (n=${baseline.length}, ${day(oldest.observedAt)} to ${day(newest.observedAt)}) minus latest ${num(latest.ndvi, 3)} = drop of ${num(drop, 3)}.`,
          evidence: [obsEvidence(latest, "Latest"), assetEvidence(latest), ...baseline.map((o) => obsEvidence(o, "Baseline"))],
          certainty: `NDVI is a deterministic calculation from surface reflectance, so the drop is measured, not predicted. ${qualityStatement(latest.quality, latest.metrics)} Baseline spread (standard deviation of the baseline means): ${num(spread, 3)}. The rule does not identify the cause of the drop.`,
          suggested_action:
            "Review the latest imagery and the NDVI series for this AOI. If the drop is not explained by harvest, mowing, or seasonal senescence, schedule a field check.",
          limitations: mergeLimitations(registryLimitations("ndvi"), latest.limitations, [
            "The baseline is a simple mean of recent observations, not a same-season climatology; seasonal change within the baseline window can account for part of the drop.",
          ]),
          basis: "deterministic_calculation",
          values: {
            latest_ndvi_mean: latest.ndvi,
            baseline_mean: baselineMean,
            baseline_std: spread,
            baseline_n: baseline.length,
            drop,
            min_drop: p.min_drop,
            collection: latest.collection,
          },
          times: { event_at: null, observed_at: latest.observedAt, ingested_at: latest.ingestedAt, processed_at: latest.processedAt },
        }),
        eventAt: null,
        observedAt: latest.observedAt,
        ingestedAt: latest.ingestedAt,
        processedAt: latest.processedAt,
        geom: { source: "aoi" },
        detectionId: null,
        observationId: latest.id,
        imageryDerived: true,
      }),
    ],
    notes: [],
  };
}

function ndviBelow(rule: EvalRule, p: RuleParams<"ndvi_below">, data: EvaluationData): RuleEvaluation {
  const latest = validNdvi(data)[0];
  if (!latest) return noteOnly(rule, "no_data", `No valid NDVI observation is stored for ${data.aoi.name}; no alert raised.`);
  if (!(latest.ndvi < p.threshold)) {
    return noteOnly(rule, "condition_not_met", `Latest NDVI ${num(latest.ndvi, 3)} (${day(latest.observedAt)}) is not below ${p.threshold}.`);
  }
  return {
    candidates: [
      candidate(rule, {
        dedupeKey: `ndvi_below:${rule.id}:${latest.id}`,
        title: `NDVI ${num(latest.ndvi, 2)} below ${p.threshold} at ${data.aoi.name}`,
        explanation: explanation(rule, p, {
          what: `Mean NDVI over ${data.aoi.name} was ${num(latest.ndvi, 3)} in the ${sourceLabel(latest)} image acquired ${when(latest.observedAt)}, below the configured threshold of ${p.threshold}.`,
          where: whereText(data.aoi),
          why: `Rule "${rule.name}" fires when the mean NDVI of the latest valid observation is below ${p.threshold}. Actual: ${num(latest.ndvi, 3)} (median ${num(finite(latest.metrics.median) ?? NaN, 3)}, 10th–90th percentile ${num(finite(latest.metrics.p10) ?? NaN, 3)}–${num(finite(latest.metrics.p90) ?? NaN, 3)}).`,
          evidence: [obsEvidence(latest, "Latest"), assetEvidence(latest)],
          certainty: `NDVI is a deterministic calculation from surface reflectance. ${qualityStatement(latest.quality, latest.metrics)} A low value does not by itself identify a cause (bare soil, recent harvest, or stressed vegetation all read low).`,
          suggested_action: "Compare with the AOI's NDVI history and expected crop stage; schedule a field check if the low value is unexpected.",
          limitations: mergeLimitations(registryLimitations("ndvi"), latest.limitations),
          basis: "deterministic_calculation",
          values: { latest_ndvi_mean: latest.ndvi, threshold: p.threshold, collection: latest.collection },
          times: { event_at: null, observed_at: latest.observedAt, ingested_at: latest.ingestedAt, processed_at: latest.processedAt },
        }),
        eventAt: null,
        observedAt: latest.observedAt,
        ingestedAt: latest.ingestedAt,
        processedAt: latest.processedAt,
        geom: { source: "aoi" },
        detectionId: null,
        observationId: latest.id,
        imageryDerived: true,
      }),
    ],
    notes: [],
  };
}

// ── Detections ─────────────────────────────────────────────────

function detectionBasis(d: EvalDetection): AlertBasis {
  if (d.resultClass === "candidate_change") return "candidate_change";
  if (d.resultClass === "model_prediction") return "model_prediction";
  return "deterministic_calculation";
}

function detectionEvidence(d: EvalDetection): AlertEvidence[] {
  const ev: AlertEvidence[] = [
    {
      type: "detection",
      id: d.id,
      label: `Detection "${d.title}" (${d.type}, ${d.areaM2 != null ? formatArea(d.areaM2) : "area unknown"}, evidence ${d.evidenceGrade}, ${d.verificationStatus})`,
      observed_at: iso(d.comparisonObservedAt ?? d.lastObservedAt),
    },
  ];
  if (d.baselineObservationId) {
    ev.push({ type: "observation", id: d.baselineObservationId, label: "Baseline observation", observed_at: iso(d.baselineObservedAt) });
  }
  if (d.comparisonObservationId) {
    ev.push({ type: "observation", id: d.comparisonObservationId, label: "Comparison observation", observed_at: iso(d.comparisonObservedAt) });
  }
  for (const a of d.sourceAssetIds) ev.push({ type: "source_asset", id: a, label: "Source scene", observed_at: null });
  return ev;
}

function detectionCandidate(rule: EvalRule, params: Record<string, unknown>, d: EvalDetection, data: EvaluationData, keyPrefix: string, why: string, suggested: string): AlertCandidate {
  const observedAt = d.comparisonObservedAt ?? d.lastObservedAt;
  const dates =
    d.baselineObservedAt && d.comparisonObservedAt
      ? ` comparing imagery acquired ${day(d.baselineObservedAt)} and ${day(d.comparisonObservedAt)}`
      : ` from imagery acquired up to ${day(observedAt)}`;
  const direction = typeof d.metrics.direction === "string" ? ` Direction: ${String(d.metrics.direction).replace(/_/g, " ")}.` : "";
  const delta = finite(d.metrics.mean_delta) != null ? ` Mean change in index: ${num(d.metrics.mean_delta as number, 3)}.` : "";
  const kind = d.resultClass === "candidate_change" ? "A candidate change" : "A detection";
  return candidate(rule, {
    dedupeKey: `${keyPrefix}:${rule.id}:${d.id}`,
    title: `Candidate ${d.type.replace(/_/g, " ")} (${d.areaM2 != null ? formatArea(d.areaM2) : "area unknown"}) at ${data.aoi.name}`,
    explanation: explanation(rule, params, {
      what: `${kind} ("${d.title}") was recorded by ${d.modelId ?? "the change model"}${d.modelVersion ? `@${d.modelVersion}` : ""}${dates}.${direction}${delta}`,
      where: regionWhereText(data.aoi, { areaM2: d.areaM2, centroid: d.centroid }),
      why,
      evidence: detectionEvidence(d),
      certainty: detectionCertainty(d),
      suggested_action: suggested,
      limitations: mergeLimitations(registryLimitations(d.modelId), d.limitations),
      basis: detectionBasis(d),
      values: {
        detection_type: d.type,
        area_m2: d.areaM2,
        evidence_grade: d.evidenceGrade,
        verification_status: d.verificationStatus,
        direction: typeof d.metrics.direction === "string" ? d.metrics.direction : null,
      },
      times: { event_at: null, observed_at: observedAt, ingested_at: d.ingestedAt, processed_at: d.createdAt },
    }),
    eventAt: null,
    observedAt,
    ingestedAt: d.ingestedAt,
    processedAt: d.createdAt,
    geom: { source: "detection", detectionId: d.id },
    detectionId: d.id,
    observationId: d.comparisonObservationId,
    imageryDerived: true,
  });
}

function detectionCreated(rule: EvalRule, p: RuleParams<"detection_created">, data: EvaluationData): RuleEvaluation {
  // Only detections recorded after the rule existed are "new" to it.
  const considered = data.detections.filter((d) => d.createdAt >= rule.createdAt && d.verificationStatus !== "dismissed");
  if (considered.length === 0) return noteOnly(rule, "no_data", "No new (non-dismissed) detections to evaluate.");
  const minRank = gradeRank(p.min_evidence_grade);
  const matched = considered.filter(
    (d) =>
      (p.types.length === 0 || p.types.includes(d.type)) &&
      (p.min_area_m2 <= 0 || (d.areaM2 != null && d.areaM2 >= p.min_area_m2)) &&
      gradeRank(d.evidenceGrade) >= minRank,
  );
  if (matched.length === 0) {
    return noteOnly(rule, "condition_not_met", `${considered.length} detection(s) considered; none matched the type, area, and evidence-grade filters.`);
  }
  const filters = `${p.types.length ? `type ${p.types.join(" or ")}` : "any type"}, area at least ${formatArea(p.min_area_m2)}, evidence grade ${p.min_evidence_grade} or stronger`;
  return {
    candidates: matched.map((d) =>
      detectionCandidate(
        rule,
        p,
        d,
        data,
        "detection",
        `Rule "${rule.name}" fires once for each new detection with ${filters}. Actual: type ${d.type}, area ${d.areaM2 != null ? formatArea(d.areaM2) : "unknown"}, evidence grade ${d.evidenceGrade}.`,
        "Review the detection against the before and after imagery, then mark it confirmed, needing a field check, or dismissed.",
      ),
    ),
    notes: [],
  };
}

// ── Weather ────────────────────────────────────────────────────

export type DailyValue = {
  day: string;
  value: number;
  kind: WeatherKind;
  providerId: string;
  unit: string;
  recordIds: string[];
  validTo: Date;
  issuedAt: Date | null;
  retrievedAt: Date;
  stationId: string | null;
  stationDistanceKm: number | null;
  resolution: "daily" | "subdaily";
};

/**
 * Collapse weather records into one value per calendar day (UTC date of each
 * record's midpoint). Only complete days are returned: one daily record, or
 * sub-daily records covering at least 22 h (DST-safe). When several sources
 * cover a day, the first kind in `kinds` wins, then daily over sub-daily
 * resolution, then provider id — so sources are never summed together.
 */
export function dailySeries(
  records: readonly EvalWeather[],
  variable: string,
  kinds: readonly WeatherKind[],
  agg: "sum" | "max",
  resolutions: readonly ("daily" | "subdaily")[] = ["daily", "subdaily"],
): DailyValue[] {
  type Group = { kind: WeatherKind; providerId: string; resolution: "daily" | "subdaily"; day: string; records: EvalWeather[]; hours: number };
  const groups = new Map<string, Group>();
  for (const r of records) {
    if (r.variable !== variable || !kinds.includes(r.recordKind) || r.value == null || !Number.isFinite(r.value)) continue;
    const hours = (r.validTo.getTime() - r.validFrom.getTime()) / 3_600_000;
    if (hours <= 0 || hours > 26) continue; // multi-day aggregates are not split
    const resolution = hours >= 20 ? "daily" : "subdaily";
    if (!resolutions.includes(resolution)) continue;
    const d = day(new Date((r.validFrom.getTime() + r.validTo.getTime()) / 2));
    const key = `${r.recordKind}|${r.providerId}|${resolution}|${d}`;
    const g = groups.get(key) ?? { kind: r.recordKind, providerId: r.providerId, resolution, day: d, records: [], hours: 0 };
    g.records.push(r);
    g.hours += hours;
    groups.set(key, g);
  }
  const best = new Map<string, Group>();
  const rank = (g: Group) => [kinds.indexOf(g.kind), g.resolution === "daily" ? 0 : 1] as const;
  for (const g of groups.values()) {
    if (g.hours < (g.resolution === "daily" ? 20 : 22)) continue;
    const cur = best.get(g.day);
    if (!cur) {
      best.set(g.day, g);
      continue;
    }
    const [a1, a2] = rank(g);
    const [b1, b2] = rank(cur);
    if (a1 < b1 || (a1 === b1 && (a2 < b2 || (a2 === b2 && g.providerId < cur.providerId)))) best.set(g.day, g);
  }
  return [...best.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((g) => {
      const vals = g.records.map((r) => r.value as number);
      const sorted = [...g.records].sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime());
      return {
        day: g.day,
        value: agg === "sum" ? vals.reduce((a, b) => a + b, 0) : Math.max(...vals),
        kind: g.kind,
        providerId: g.providerId,
        unit: g.records[0]!.unit,
        recordIds: sorted.map((r) => r.id),
        validTo: new Date(Math.max(...g.records.map((r) => r.validTo.getTime()))),
        issuedAt: maxDate(g.records.map((r) => r.issuedAt)),
        retrievedAt: maxDate(g.records.map((r) => r.retrievedAt))!,
        stationId: g.records.find((r) => r.stationId)?.stationId ?? null,
        stationDistanceKm: g.records.reduce<number | null>((m, r) => (r.stationDistanceKm == null ? m : Math.max(m ?? 0, r.stationDistanceKm)), null),
        resolution: g.resolution,
      };
    });
}

function maxDate(ds: (Date | null)[]): Date | null {
  let m: Date | null = null;
  for (const d of ds) if (d && (!m || d > m)) m = d;
  return m;
}

/** Maximal runs of consecutive calendar days satisfying a predicate. */
export function consecutiveRuns(series: readonly DailyValue[], pred: (v: DailyValue) => boolean): DailyValue[][] {
  const runs: DailyValue[][] = [];
  let cur: DailyValue[] = [];
  for (const v of series) {
    const prev = cur[cur.length - 1];
    if (pred(v) && (!prev || addDays(prev.day, 1) === v.day)) cur.push(v);
    else {
      if (cur.length) runs.push(cur);
      cur = pred(v) ? [v] : [];
    }
  }
  if (cur.length) runs.push(cur);
  return runs;
}

/** Number of consecutive calendar days with data ending at the last day of the series. */
function trailingDataDays(series: readonly DailyValue[]): number {
  let n = 0;
  for (let i = series.length - 1; i >= 0; i--) {
    if (i < series.length - 1 && addDays(series[i]!.day, 1) !== series[i + 1]!.day) break;
    n++;
  }
  return n;
}

function weatherEvidence(days: readonly DailyValue[], variableLabel: string): AlertEvidence[] {
  return days.map((d) => ({
    type: "weather" as const,
    id: d.recordIds[0]!,
    ids: d.recordIds,
    label: `${variableLabel} ${d.day}: ${num(d.value, 1)} ${d.unit} (${d.kind.replace("_", " ")}, ${d.providerId}${d.resolution === "subdaily" ? `, ${d.recordIds.length} sub-daily records` : ""}${d.issuedAt && d.kind === "forecast" ? `, issued ${when(d.issuedAt)}` : ""})`,
    observed_at: iso(d.validTo),
  }));
}

function weatherBasis(days: readonly DailyValue[]): AlertBasis {
  if (days.some((d) => d.kind === "forecast")) return "forecast";
  return days.every((d) => d.kind === "observation") ? "observation" : "model_estimate";
}

function kindBreakdown(days: readonly DailyValue[]): string {
  const obs = days.filter((d) => d.kind === "observation").length;
  const est = days.filter((d) => d.kind === "model_estimate").length;
  const parts: string[] = [];
  if (obs) parts.push(`${obs} day(s) from station observations`);
  if (est) parts.push(`${est} day(s) from model estimates`);
  return parts.join(", ");
}

function weatherCertainty(days: readonly DailyValue[]): string {
  const kinds = [...new Set(days.map((d) => d.kind))];
  const providers = [...new Set(days.map((d) => d.providerId))].join(", ");
  const parts = kinds.map((k) => WEATHER_KIND_CAVEAT[k]);
  const dist = days.reduce<number | null>((m, d) => (d.stationDistanceKm == null ? m : Math.max(m ?? 0, d.stationDistanceKm)), null);
  if (dist != null) parts.push(`The station(s) used are up to ${num(dist, 1)} km from the AOI.`);
  if (kinds.includes("forecast")) {
    const issued = maxDate(days.map((d) => d.issuedAt));
    parts.unshift(`Based on the forecast issued ${when(issued)} by ${providers}.`);
  } else {
    parts.unshift(`Based on records from ${providers}.`);
  }
  return parts.join(" ");
}

function weatherTimes(days: readonly DailyValue[], now: Date) {
  const forecast = days.some((d) => d.kind === "forecast");
  const retrieved = maxDate(days.map((d) => d.retrievedAt));
  // A forecast's data time is when it was issued; recorded data's is the end of the covered period.
  const observedAt = forecast ? (maxDate(days.map((d) => d.issuedAt)) ?? retrieved) : maxDate(days.map((d) => d.validTo));
  return { event_at: null, observed_at: observedAt, ingested_at: retrieved, processed_at: now };
}

function precipitationTotalAbove(rule: EvalRule, p: RuleParams<"precipitation_total_above">, data: EvaluationData): RuleEvaluation {
  const forecast = p.kinds[0] === "forecast";
  const today = day(data.now);
  const series = dailySeries(data.weather, "precipitation_mm", p.kinds, "sum").filter((d) => (forecast ? d.day >= today : d.day <= today));
  if (series.length === 0) {
    return noteOnly(rule, "no_data", `No complete daily precipitation ${forecast ? "forecasts" : "records"} (${p.kinds.join(", ")}) are stored for ${data.aoi.name}.`);
  }
  const start = forecast ? today : addDays(series[series.length - 1]!.day, -(p.window_days - 1));
  const end = forecast ? addDays(today, p.window_days - 1) : series[series.length - 1]!.day;
  const inWindow = series.filter((d) => d.day >= start && d.day <= end);
  if (inWindow.length === 0) return noteOnly(rule, "no_data", `No complete precipitation data between ${start} and ${end}.`);
  const total = inWindow.reduce((a, d) => a + d.value, 0);
  const missing = p.window_days - inWindow.length;
  if (!(total > p.threshold_mm)) {
    return missing > 0
      ? noteOnly(rule, "insufficient_data", `Only ${inWindow.length} of ${p.window_days} days between ${start} and ${end} have complete precipitation data (total so far ${num(total, 1)} mm); cannot determine whether ${p.threshold_mm} mm was exceeded.`)
      : noteOnly(rule, "condition_not_met", `Precipitation ${start} to ${end}: ${num(total, 1)} mm, not above ${p.threshold_mm} mm.`);
  }
  const basis = weatherBasis(inWindow);
  const coverage = missing > 0 ? ` ${missing} day(s) lack complete data and are not counted, so the true total can only be higher.` : "";
  const label = basis === "observation" ? "Observed" : basis === "model_estimate" ? "Estimated (model)" : "Forecast";
  const title = forecast
    ? `Forecast: ${num(total, 1)} mm of precipitation expected ${start} to ${end} at ${data.aoi.name}`
    : `${label} precipitation ${num(total, 1)} mm over ${p.window_days} day(s) at ${data.aoi.name}`;
  const what = forecast
    ? `A weather forecast — a prediction, not an observation — expects ${num(total, 1)} mm of precipitation at ${data.aoi.name} between ${start} and ${end}.`
    : `${num(total, 1)} mm of precipitation was recorded for ${data.aoi.name} between ${start} and ${end} (${kindBreakdown(inWindow)}).`;
  const times = weatherTimes(inWindow, data.now);
  return {
    candidates: [
      candidate(rule, {
        dedupeKey: forecast ? `precip:${rule.id}:${data.aoi.id}:forecast:${end}` : `precip:${rule.id}:${data.aoi.id}:${end}`,
        title,
        explanation: explanation(rule, p, {
          what,
          where: whereText(data.aoi),
          why: `Rule "${rule.name}" fires when ${forecast ? "forecast" : "recorded"} precipitation over ${p.window_days} day(s) exceeds ${p.threshold_mm} mm (record kinds: ${p.kinds.join(", ")}). Actual total: ${num(total, 1)} mm from ${inWindow.length} of ${p.window_days} day(s) with complete data.${coverage}`,
          evidence: weatherEvidence(inWindow, "Precipitation"),
          certainty: weatherCertainty(inWindow),
          suggested_action: forecast
            ? "Treat this as a forecast: check drainage, consider postponing field operations or applications that heavy rain would wash off, and re-check the latest forecast before acting."
            : "Check fields and low-lying areas for waterlogging, runoff, or erosion.",
          limitations: mergeLimitations(
            [...new Set(inWindow.map((d) => d.kind))].map((k) => WEATHER_KIND_CAVEAT[k]),
            ["Daily totals are taken from a single source per day; days without complete records are excluded rather than estimated."],
          ),
          basis,
          values: {
            total_mm: Math.round(total * 10) / 10,
            threshold_mm: p.threshold_mm,
            window_days: p.window_days,
            days_with_data: inWindow.length,
            window_start: start,
            window_end: end,
            record_kinds: [...new Set(inWindow.map((d) => d.kind))].join(","),
          },
          times,
        }),
        eventAt: null,
        observedAt: times.observed_at,
        ingestedAt: times.ingested_at,
        processedAt: data.now,
        geom: { source: "aoi" },
        detectionId: null,
        observationId: null,
        imageryDerived: false,
      }),
    ],
    notes: [],
  };
}

function drySpell(rule: EvalRule, p: RuleParams<"dry_spell">, data: EvaluationData): RuleEvaluation {
  const today = day(data.now);
  const series = dailySeries(data.weather, "precipitation_mm", ["observation", "model_estimate"], "sum").filter((d) => d.day <= today);
  if (series.length === 0) return noteOnly(rule, "no_data", `No complete daily precipitation records are stored for ${data.aoi.name}.`);
  const latestDay = series[series.length - 1]!.day;
  const runs = consecutiveRuns(series, (d) => d.value <= p.max_daily_mm + 1e-9);
  const run = runs.filter((r) => r.length >= p.days && r[r.length - 1]!.day >= addDays(latestDay, -7)).pop();
  if (!run) {
    const continuous = trailingDataDays(series);
    return continuous < p.days
      ? noteOnly(rule, "insufficient_data", `Only ${continuous} consecutive day(s) of complete precipitation data end on ${latestDay}; the rule needs ${p.days}. Missing days are never assumed dry.`)
      : noteOnly(rule, "condition_not_met", `No run of ${p.days} consecutive days at or below ${p.max_daily_mm} mm/day in the recent record (latest data ${latestDay}).`);
  }
  const start = run[0]!.day;
  const end = run[run.length - 1]!.day;
  const ongoing = end === latestDay;
  const total = run.reduce((a, d) => a + d.value, 0);
  const basis = weatherBasis(run);
  const times = weatherTimes(run, data.now);
  return {
    candidates: [
      candidate(rule, {
        dedupeKey: `dry_spell:${rule.id}:${data.aoi.id}:${start}`,
        title: `${basis === "model_estimate" ? "Estimated dry spell" : "Dry spell"}: ${run.length} days at or below ${p.max_daily_mm} mm/day at ${data.aoi.name}`,
        explanation: explanation(rule, p, {
          what: `${run.length} consecutive days (${start} to ${end}) with at most ${p.max_daily_mm} mm of precipitation per day were recorded for ${data.aoi.name} (${kindBreakdown(run)}); total ${num(total, 1)} mm.${ongoing ? " The spell continues through the latest available data." : ""}`,
          where: whereText(data.aoi),
          why: `Rule "${rule.name}" fires when daily precipitation stays at or below ${p.max_daily_mm} mm for at least ${p.days} consecutive days. Actual: ${run.length} days. Days without complete data break a spell.`,
          evidence: weatherEvidence(run, "Precipitation"),
          certainty: weatherCertainty(run),
          suggested_action: "Check soil moisture and crop condition; review irrigation schedules where available.",
          limitations: mergeLimitations([...new Set(run.map((d) => d.kind))].map((k) => WEATHER_KIND_CAVEAT[k]), [
            "Light precipitation below the dry-day threshold is not counted as rain.",
          ]),
          basis,
          values: { spell_days: run.length, required_days: p.days, max_daily_mm: p.max_daily_mm, spell_start: start, spell_end: end, total_mm: Math.round(total * 10) / 10, ongoing },
          times,
        }),
        eventAt: null,
        observedAt: times.observed_at,
        ingestedAt: times.ingested_at,
        processedAt: data.now,
        geom: { source: "aoi" },
        detectionId: null,
        observationId: null,
        imageryDerived: false,
      }),
    ],
    notes: [],
  };
}

function heatStress(rule: EvalRule, p: RuleParams<"heat_stress">, data: EvaluationData): RuleEvaluation {
  const forecast = p.kind === "forecast";
  const today = day(data.now);
  // Daily maxima; complete hourly temperatures are an acceptable substitute (never daily means).
  let series = dailySeries(data.weather, "temperature_max_c", [p.kind], "max");
  if (series.length === 0) series = dailySeries(data.weather, "temperature_c", [p.kind], "max", ["subdaily"]);
  series = series.filter((d) => (forecast ? d.day >= today : d.day <= today));
  if (series.length === 0) {
    return noteOnly(rule, "no_data", `No complete daily maximum temperature records of kind "${p.kind}" are stored for ${data.aoi.name}.`);
  }
  const latestDay = series[series.length - 1]!.day;
  const runs = consecutiveRuns(series, (d) => d.value >= p.threshold_c - 1e-9).filter((r) => r.length >= p.consecutive_days);
  const run = forecast ? runs[0] : runs.filter((r) => r[r.length - 1]!.day >= addDays(latestDay, -7)).pop();
  if (!run) {
    return trailingDataDays(series) < p.consecutive_days
      ? noteOnly(rule, "insufficient_data", `Fewer than ${p.consecutive_days} consecutive day(s) of complete ${p.kind} temperature data; no alert raised.`)
      : noteOnly(rule, "condition_not_met", `No run of ${p.consecutive_days} day(s) with maximum temperature at or above ${p.threshold_c} °C (${p.kind}).`);
  }
  const start = run[0]!.day;
  const end = run[run.length - 1]!.day;
  const peak = Math.max(...run.map((d) => d.value));
  const times = weatherTimes(run, data.now);
  const prefix = forecast ? "Forecast: heat stress" : p.kind === "model_estimate" ? "Estimated heat stress (model)" : "Heat stress";
  const what = forecast
    ? `A weather forecast — a prediction, not an observation — expects daily maximum temperatures at or above ${p.threshold_c} °C at ${data.aoi.name} on ${run.length} consecutive day(s), ${start} to ${end} (peak ${num(peak, 1)} °C).`
    : `Daily maximum temperature at ${data.aoi.name} reached ${p.threshold_c} °C or more on ${run.length} consecutive day(s), ${start} to ${end} (peak ${num(peak, 1)} °C), according to ${p.kind === "model_estimate" ? "model estimates" : "station observations"}.`;
  return {
    candidates: [
      candidate(rule, {
        dedupeKey: `heat:${rule.id}:${data.aoi.id}:${p.kind}:${start}`,
        title: `${prefix}: ${run.length} day(s) at or above ${p.threshold_c} °C at ${data.aoi.name}`,
        explanation: explanation(rule, p, {
          what,
          where: whereText(data.aoi),
          why: `Rule "${rule.name}" fires when the daily maximum temperature (${p.kind.replace("_", " ")}) is at or above ${p.threshold_c} °C on at least ${p.consecutive_days} consecutive day(s). Actual: ${run.length} day(s), peak ${num(peak, 1)} °C.`,
          evidence: weatherEvidence(run, "Maximum temperature"),
          certainty: weatherCertainty(run),
          suggested_action: forecast
            ? "Plan ahead for heat: review irrigation, livestock shade and water, and outdoor work schedules; re-check the latest forecast."
            : "Check crops and livestock for heat stress and review irrigation.",
          limitations: mergeLimitations([WEATHER_KIND_CAVEAT[p.kind]]),
          basis: weatherBasis(run),
          values: { days: run.length, required_days: p.consecutive_days, threshold_c: p.threshold_c, peak_c: peak, start, end, record_kind: p.kind },
          times,
        }),
        eventAt: null,
        observedAt: times.observed_at,
        ingestedAt: times.ingested_at,
        processedAt: data.now,
        geom: { source: "aoi" },
        detectionId: null,
        observationId: null,
        imageryDerived: false,
      }),
    ],
    notes: [],
  };
}

// ── Official warnings ──────────────────────────────────────────

function nwsWarning(rule: EvalRule, p: RuleParams<"nws_warning">, data: EvaluationData): RuleEvaluation {
  const active = data.warnings.filter((w) => !w.eventEnd || w.eventEnd > data.now);
  if (active.length === 0) return noteOnly(rule, "no_data", `No active official warnings are stored for ${data.aoi.name}.`);
  const min = warningSeverityRank(p.min_severity);
  const matched = active.filter((w) => warningSeverityRank(w.severity) >= min);
  if (matched.length === 0) {
    return noteOnly(rule, "condition_not_met", `${active.length} active warning(s); none at or above ${p.min_severity} severity.`);
  }
  return {
    candidates: matched.map((w) => {
      const observedAt = w.publishedAt ?? w.retrievedAt;
      const period = `${w.eventStart ? `from ${when(w.eventStart)}` : "onset not stated"}${w.eventEnd ? ` until ${when(w.eventEnd)}` : ""}`;
      return candidate(rule, {
        dedupeKey: `warning:${rule.id}:${w.id}`,
        title: `Official ${w.severity ?? ""} warning: ${w.title}`.replace(/\s+/g, " "),
        explanation: explanation(rule, p, {
          what: `${w.providerId} issued an official warning, "${w.title}" (severity ${w.severity ?? "not stated"}${w.category ? `, category ${w.category}` : ""}), ${period}. This is an agency warning relayed as issued — not an ORYN observation or forecast.`,
          where: `${whereText(data.aoi)}; the warning area overlaps this AOI.`,
          why: `Rule "${rule.name}" fires for each active official warning at or above ${p.min_severity} severity. Actual: severity ${w.severity ?? "not stated"}, published ${when(w.publishedAt)}.`,
          evidence: [{ type: "warning", id: w.id, label: `${w.providerId}: ${w.title}`, observed_at: iso(observedAt) }],
          certainty: `As rated by the issuing agency: certainty "${w.certainty ?? "not stated"}", urgency "${w.urgency ?? "not stated"}". ORYN relays the warning and does not assess it.`,
          suggested_action: `Follow the instructions in the official warning${w.sourceUrl ? ` (${w.sourceUrl})` : ""} and check the issuing agency for updates.`,
          limitations: mergeLimitations([
            "Warning areas are usually much larger than an AOI; conditions vary within them.",
            "ORYN polls warning feeds on a schedule, so a warning can reach ORYN some minutes after it is issued.",
          ]),
          basis: "official_warning",
          values: { warning_severity: w.severity, min_severity: p.min_severity, certainty: w.certainty, urgency: w.urgency },
          times: { event_at: w.eventStart, observed_at: observedAt, ingested_at: w.retrievedAt, processed_at: data.now },
        }),
        eventAt: w.eventStart,
        observedAt,
        ingestedAt: w.retrievedAt,
        processedAt: data.now,
        geom: { source: "aoi" },
        detectionId: null,
        observationId: null,
        imageryDerived: false,
      });
    }),
    notes: [],
  };
}

// ── Surface water ──────────────────────────────────────────────

const WATER_KINDS = ["ndwi", "s1_water"];

function isNewWaterDetection(d: EvalDetection): boolean {
  const direction = typeof d.metrics.direction === "string" ? d.metrics.direction : null;
  if (direction === "water_loss" || direction === "decrease") return false;
  return d.modelId === "water-change" || direction === "new_water" || d.type.includes("water");
}

function newWaterArea(rule: EvalRule, p: RuleParams<"new_water_area">, data: EvaluationData): RuleEvaluation {
  const candidates: AlertCandidate[] = [];
  const notes: EvaluationNote[] = [];

  const detections = data.detections.filter(
    (d) => d.createdAt >= rule.createdAt && d.verificationStatus !== "dismissed" && gradeRank(d.evidenceGrade) >= gradeRank("weak") && isNewWaterDetection(d),
  );
  for (const d of detections) {
    if (d.areaM2 == null || d.areaM2 < p.min_area_m2) continue;
    candidates.push(
      detectionCandidate(
        rule,
        p,
        d,
        data,
        "new_water",
        `Rule "${rule.name}" fires for new-surface-water detections of at least ${formatArea(p.min_area_m2)}. Actual: ${formatArea(d.areaM2)}, evidence grade ${d.evidenceGrade}.`,
        "Check the detection against the imagery and local knowledge (reservoir levels, irrigation, flooding) and mark it confirmed or dismissed.",
      ),
    );
  }

  // Observation-based increase between the two latest valid observations of one water product.
  const water = data.observations
    .filter((o) => WATER_KINDS.includes(o.kind) && o.status === "valid" && finite(o.metrics.water_area_m2) != null)
    .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime());
  const latest = water[0];
  if (!latest) {
    if (candidates.length === 0) notes.push(note(rule, detections.length ? "condition_not_met" : "no_data", "No qualifying water detections and no valid water observations."));
    return { candidates, notes };
  }
  const prev = water.find((o) => o.id !== latest.id && o.kind === latest.kind && o.collection === latest.collection && o.observedAt < latest.observedAt);
  if (!prev) {
    notes.push(note(rule, "insufficient_data", `Only one valid ${latest.kind} observation from ${latest.collection}; an earlier one is needed to measure an increase.`));
    return { candidates, notes };
  }
  const vf = (o: EvalObservation) => finite(o.metrics.valid_fraction) ?? 0;
  if (vf(latest) < p.min_valid_fraction || vf(prev) < p.min_valid_fraction) {
    notes.push(
      note(rule, "insufficient_data", `Water areas not compared: valid pixel fractions ${pct(vf(prev))} and ${pct(vf(latest))} are below the required ${pct(p.min_valid_fraction)}.`),
    );
    return { candidates, notes };
  }
  if (data.detections.some((d) => d.comparisonObservationId === latest.id && isNewWaterDetection(d))) {
    return { candidates, notes }; // the change model already reported this pair as detections
  }
  const before = prev.metrics.water_area_m2 as number;
  const after = latest.metrics.water_area_m2 as number;
  const delta = after - before;
  if (delta + 1e-6 < p.min_area_m2) {
    if (candidates.length === 0) {
      notes.push(note(rule, "condition_not_met", `Water area changed by ${formatArea(Math.abs(delta))} (${delta >= 0 ? "increase" : "decrease"}); below ${formatArea(p.min_area_m2)}.`));
    }
    return { candidates, notes };
  }
  const model = latest.modelId;
  candidates.push(
    candidate(rule, {
      dedupeKey: `water_increase:${rule.id}:${latest.id}`,
      title: `Surface water increased by ${formatArea(delta)} at ${data.aoi.name}`,
      explanation: explanation(rule, p, {
        what: `Open-water area measured by ${model}@${latest.modelVersion} (${sourceLabel(latest)}) rose from ${formatArea(before)} on ${day(prev.observedAt)} to ${formatArea(after)} on ${day(latest.observedAt)}.`,
        where: whereText(data.aoi),
        why: `Rule "${rule.name}" fires when the water area of the latest valid water observation exceeds the previous valid observation of the same product by at least ${formatArea(p.min_area_m2)}. Actual increase: ${formatArea(delta)}.`,
        evidence: [obsEvidence(latest, "Latest"), assetEvidence(latest), obsEvidence(prev, "Previous"), assetEvidence(prev)],
        certainty: `Latest: ${qualityStatement(latest.quality, latest.metrics)} Previous: ${qualityStatement(prev.quality, prev.metrics)} Water pixels are open-water candidates from a fixed threshold, not surveyed water extent.`,
        suggested_action: "Check whether the increase is expected (reservoir filling, irrigation) or indicates ponding or flooding; inspect low-lying areas.",
        limitations: mergeLimitations(registryLimitations(model === "s1-water" ? "s1-water" : "ndwi"), latest.limitations, [
          "Water area is computed over valid pixels only; differences in masking between the two dates affect the comparison.",
        ]),
        basis: model === "s1-water" ? "model_prediction" : "deterministic_calculation",
        values: { water_area_before_m2: before, water_area_after_m2: after, increase_m2: delta, min_area_m2: p.min_area_m2 },
        times: { event_at: null, observed_at: latest.observedAt, ingested_at: latest.ingestedAt, processed_at: latest.processedAt },
      }),
      eventAt: null,
      observedAt: latest.observedAt,
      ingestedAt: latest.ingestedAt,
      processedAt: latest.processedAt,
      geom: { source: "aoi" },
      detectionId: null,
      observationId: latest.id,
      imageryDerived: true,
    }),
  );
  return { candidates, notes };
}

// ── Data gaps ──────────────────────────────────────────────────

function staleObservations(rule: EvalRule, p: RuleParams<"stale_observations">, data: EvaluationData): RuleEvaluation {
  const counts = (o: EvalObservation) => p.kinds.length === 0 || p.kinds.includes(o.kind);
  const latest = data.latestValidByKind.filter(counts).sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())[0];
  const limitMs = p.max_age_days * DAY_MS;
  const kindsText = p.kinds.length ? ` (${p.kinds.join(", ")})` : "";
  if (latest && data.now.getTime() - latest.observedAt.getTime() <= limitMs) {
    return noteOnly(rule, "condition_not_met", `Latest valid observation${kindsText} acquired ${day(latest.observedAt)} is within ${p.max_age_days} days.`);
  }
  if (!latest && data.now.getTime() - data.aoi.createdAt.getTime() <= limitMs) {
    return noteOnly(rule, "no_data", `No valid observation yet, but the AOI is younger than ${p.max_age_days} days; no alert raised.`);
  }
  const ageDays = latest ? Math.floor((data.now.getTime() - latest.observedAt.getTime()) / DAY_MS) : null;
  const unusable = data.observations.filter((o) => counts(o) && o.status === "unusable" && (!latest || o.observedAt > latest.observedAt));
  const reasons = [...new Set(unusable.map((o) => o.quality.unusable_reason).filter((r): r is string => Boolean(r)))];
  const unusableText = unusable.length
    ? ` ${unusable.length} newer acquisition(s) were processed but unusable${reasons.length ? ` (${reasons.join("; ")})` : ""}.`
    : "";
  const evidence: AlertEvidence[] = [];
  if (latest) evidence.push(obsEvidence(latest, "Latest usable"));
  for (const o of unusable.slice(0, 10)) {
    evidence.push({ type: "observation", id: o.id, label: `Unusable ${o.kind} acquisition: ${o.quality.unusable_reason ?? "reason not recorded"}`, observed_at: iso(o.observedAt) });
  }
  return {
    candidates: [
      candidate(rule, {
        dedupeKey: `stale:${rule.id}:${data.aoi.id}:${latest?.id ?? "none"}`,
        title: latest
          ? `Data gap: no usable imagery for ${ageDays} days at ${data.aoi.name}`
          : `Data gap: no usable imagery recorded yet for ${data.aoi.name}`,
        explanation: explanation(rule, p, {
          what: latest
            ? `No valid observation${kindsText} newer than ${p.max_age_days} days exists for ${data.aoi.name}. The latest usable one was acquired ${when(latest.observedAt)} (${ageDays} days ago).${unusableText} This is a data-gap alert, not a report of a field condition.`
            : `No valid observation${kindsText} has been recorded for ${data.aoi.name} since it was created ${when(data.aoi.createdAt)}.${unusableText} This is a data-gap alert, not a report of a field condition.`,
          where: whereText(data.aoi),
          why: `Rule "${rule.name}" fires when no valid observation${kindsText} is newer than ${p.max_age_days} days. Actual age of the latest usable observation: ${ageDays != null ? `${ageDays} days` : "none recorded"}.`,
          evidence,
          certainty: "This is an exact statement about the data ORYN holds; it says nothing about conditions on the ground.",
          suggested_action:
            "Check provider status and the AOI's processing history. Persistent cloud cover is the most common cause for optical imagery; a radar source (Sentinel-1) images through cloud.",
          limitations: mergeLimitations([
            "Satellite revisit intervals and cloud cover limit how often usable imagery exists.",
            "Monitoring conclusions drawn from older imagery may no longer reflect current conditions.",
          ]),
          basis: "data_gap",
          values: { latest_valid_observed_at: iso(latest?.observedAt), age_days: ageDays, max_age_days: p.max_age_days, newer_unusable: unusable.length },
          times: { event_at: null, observed_at: latest?.observedAt ?? null, ingested_at: latest?.ingestedAt ?? null, processed_at: data.now },
        }),
        eventAt: null,
        observedAt: latest?.observedAt ?? null,
        ingestedAt: latest?.ingestedAt ?? null,
        processedAt: data.now,
        geom: { source: "aoi" },
        detectionId: null,
        observationId: latest?.id ?? null,
        imageryDerived: false,
      }),
    ],
    notes: [],
  };
}

/** Human label of the evidence basis (exported for UI and email rendering). */
export function basisLabel(b: AlertBasis): string {
  return BASIS_LABEL[b];
}
