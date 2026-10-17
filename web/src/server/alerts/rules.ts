/**
 * Alert rule catalog.
 *
 * Every rule an organization can configure is one of these types. Each type
 * declares a zod schema for its parameters (defaults are documented
 * conventions, never invented thresholds), the organization kinds it applies
 * to, the stored data it reads, and which pipeline triggers re-evaluate it.
 *
 * Guarantees
 *  - Parameters are validated and normalized (defaults applied) before they
 *    are stored, so evaluation never sees an unvalidated rule.
 *  - A rule type that needs data ORYN does not have produces no alert; the
 *    evaluator returns an "insufficient data" note instead (see evaluate.ts).
 */
import { z } from "zod";
import type { OrgKind } from "@/server/authz/access";
import { DomainError } from "@/server/errors";

export const SEVERITIES = ["info", "low", "moderate", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Evidence grades assigned by change models, weakest first. */
export const EVIDENCE_GRADES = ["insufficient", "weak", "moderate", "strong"] as const;
export type EvidenceGrade = (typeof EVIDENCE_GRADES)[number];
export const gradeRank = (g: string): number => EVIDENCE_GRADES.indexOf(g as EvidenceGrade);

/** CAP severity levels used by official warnings, weakest first. */
export const WARNING_SEVERITIES = ["Minor", "Moderate", "Severe", "Extreme"] as const;
export type WarningSeverity = (typeof WARNING_SEVERITIES)[number];
export const warningSeverityRank = (s: string | null | undefined): number =>
  s ? WARNING_SEVERITIES.findIndex((w) => w.toLowerCase() === s.toLowerCase()) : -1;

export type TriggerKind = "observation" | "detection" | "weather" | "warning" | "schedule";

export type DataRequirement =
  | "ndvi_observations"
  | "water_observations"
  | "any_observations"
  | "detections"
  | "weather_observation"
  | "weather_model_estimate"
  | "weather_forecast"
  | "official_warnings";

const ALL_KINDS: readonly OrgKind[] = ["agriculture", "municipal", "infrastructure", "enterprise", "public_sector"];
const LAND_KINDS: readonly OrgKind[] = ["agriculture", "municipal", "enterprise", "public_sector"];

const observedKinds = z.array(z.enum(["observation", "model_estimate"])).min(1).max(2);
const forecastKinds = z.tuple([z.literal("forecast")]);

export const RULE_TYPES = {
  ndvi_drop_vs_baseline: {
    label: "Vegetation (NDVI) drop vs. own baseline",
    description:
      "Fires when the latest valid NDVI observation of an AOI is lower than the mean of the AOI's own prior valid NDVI observations from the same sensor collection by at least the configured amount.",
    params: z.strictObject({
      /** Minimum drop in mean NDVI (absolute index units). */
      min_drop: z.number().gt(0).max(2).default(0.1),
      /** Minimum number of prior observations required to form a baseline. */
      min_baseline_n: z.number().int().min(1).max(100).default(3),
      /** How far back (days before the latest observation) baseline observations may come from. */
      baseline_days: z.number().int().min(7).max(365).default(90),
    }),
    orgKinds: LAND_KINDS,
    requires: ["ndvi_observations"],
    needs: "Valid NDVI observations: the latest one plus at least min_baseline_n earlier ones from the same collection within baseline_days.",
    triggers: ["observation", "schedule"],
  },
  ndvi_below: {
    label: "Vegetation (NDVI) below threshold",
    description: "Fires when the mean NDVI of the latest valid NDVI observation of an AOI is below the configured threshold.",
    params: z.strictObject({
      threshold: z.number().min(-1).max(1),
    }),
    orgKinds: LAND_KINDS,
    requires: ["ndvi_observations"],
    needs: "At least one valid NDVI observation.",
    triggers: ["observation", "schedule"],
  },
  detection_created: {
    label: "New candidate change or zone detected",
    description:
      "Fires once per new detection — a candidate change between images, or a within-field low-vigour zone — that matches the configured types (empty: every type), minimum area, and minimum evidence grade. Dismissed detections never fire.",
    params: z.strictObject({
      /** Detection types to match; empty matches every type. */
      types: z.array(z.string().min(1).max(64)).max(20).default([]),
      min_area_m2: z.number().min(0).default(0),
      min_evidence_grade: z.enum(["weak", "moderate", "strong"]).default("moderate"),
    }),
    orgKinds: ALL_KINDS,
    requires: ["detections"],
    needs: "Detections (change candidates or low-vigour zones) recorded after the rule was created.",
    triggers: ["detection", "schedule"],
  },
  precipitation_total_above: {
    label: "Precipitation total above threshold",
    description:
      "Fires when total precipitation over a rolling window exceeds the threshold. Uses either recorded data (station observations and/or model estimates) or forecasts — never a mix of the two. Forecast-based alerts are labelled as forecasts.",
    params: z.strictObject({
      window_days: z.number().int().min(1).max(60),
      threshold_mm: z.number().gt(0).max(5000),
      kinds: z.union([observedKinds, forecastKinds]).default(["observation", "model_estimate"]),
    }),
    orgKinds: ALL_KINDS,
    requires: ["weather_observation", "weather_model_estimate", "weather_forecast"],
    needs: "Daily (or complete sub-daily) precipitation records of the selected kinds covering the window.",
    triggers: ["weather", "schedule"],
  },
  dry_spell: {
    label: "Dry spell",
    description:
      "Fires when recorded daily precipitation (observations, else model estimates) stays at or below max_daily_mm for at least the configured number of consecutive days. Days without complete data break the run — ORYN never assumes a missing day was dry.",
    params: z.strictObject({
      days: z.number().int().min(2).max(90),
      /** 1 mm is the WMO convention for a "dry day". */
      max_daily_mm: z.number().min(0).max(10).default(1),
    }),
    orgKinds: LAND_KINDS,
    requires: ["weather_observation", "weather_model_estimate"],
    needs: "Complete daily precipitation records for at least the configured number of consecutive days.",
    triggers: ["weather", "schedule"],
  },
  heat_stress: {
    label: "Heat stress",
    description:
      "Fires when the daily maximum temperature reaches the threshold on at least the configured number of consecutive days, using exactly one record kind (observation, model estimate, or forecast).",
    params: z.strictObject({
      threshold_c: z.number().min(-30).max(60),
      consecutive_days: z.number().int().min(1).max(30).default(1),
      kind: z.enum(["observation", "model_estimate", "forecast"]).default("observation"),
    }),
    orgKinds: LAND_KINDS,
    requires: ["weather_observation", "weather_model_estimate", "weather_forecast"],
    needs: "Daily maximum temperature (or complete hourly temperature) records of the selected kind.",
    triggers: ["weather", "schedule"],
  },
  nws_warning: {
    label: "Official weather warning",
    description:
      "Fires once per active official weather warning (e.g. US National Weather Service CAP alerts) affecting the AOI at or above the configured severity.",
    params: z.strictObject({
      min_severity: z.enum(["Moderate", "Severe", "Extreme"]).default("Severe"),
    }),
    orgKinds: ALL_KINDS,
    requires: ["official_warnings"],
    needs: "Official warnings retrieved for the AOI.",
    triggers: ["warning", "schedule"],
  },
  new_water_area: {
    label: "New surface water",
    description:
      "Fires for surface-water change detections (new water) of at least the configured area, or when the water area measured by the latest valid water observation exceeds the previous valid observation of the same product by at least that area.",
    params: z.strictObject({
      min_area_m2: z.number().gt(0),
      /** Both observations must have at least this fraction of valid pixels to compare areas. */
      min_valid_fraction: z.number().min(0.1).max(1).default(0.8),
    }),
    orgKinds: ALL_KINDS,
    requires: ["detections", "water_observations"],
    needs: "Water-change detections, or two valid water observations (NDWI or Sentinel-1) from the same product.",
    triggers: ["observation", "detection", "schedule"],
  },
  stale_observations: {
    label: "Imagery data gap",
    description:
      "Fires when no valid observation newer than the configured age exists for the AOI. This is a data-coverage alert, not a field condition.",
    params: z.strictObject({
      max_age_days: z.number().int().min(1).max(365),
      /** Observation kinds that count (e.g. ["ndvi"]); empty counts every kind. */
      kinds: z.array(z.string().min(1).max(64)).max(10).default([]),
    }),
    orgKinds: ALL_KINDS,
    requires: ["any_observations"],
    needs: "The AOI's observation history (none at all also counts once the AOI is older than max_age_days).",
    triggers: ["observation", "schedule"],
  },
} as const satisfies Record<
  string,
  {
    label: string;
    description: string;
    params: z.ZodType;
    orgKinds: readonly OrgKind[];
    requires: readonly DataRequirement[];
    needs: string;
    triggers: readonly TriggerKind[];
  }
>;

export type RuleTypeId = keyof typeof RULE_TYPES;
export type RuleParams<T extends RuleTypeId> = z.output<(typeof RULE_TYPES)[T]["params"]>;

export const RULE_TYPE_IDS = Object.keys(RULE_TYPES) as RuleTypeId[];

export function isRuleType(t: string): t is RuleTypeId {
  return Object.prototype.hasOwnProperty.call(RULE_TYPES, t);
}

/** Rule types re-evaluated by a trigger of this kind. */
export function ruleTypesForTrigger(kind: TriggerKind): RuleTypeId[] {
  return RULE_TYPE_IDS.filter((t) => (RULE_TYPES[t].triggers as readonly TriggerKind[]).includes(kind));
}

/**
 * Validate and normalize rule parameters. Throws a DomainError (422) naming
 * each invalid field so the UI can show it next to the input.
 */
export function parseRuleParams<T extends RuleTypeId>(type: T, params: unknown): RuleParams<T> {
  const result = RULE_TYPES[type].params.safeParse(params ?? {});
  if (!result.success) {
    const fields: Record<string, string> = {};
    for (const issue of result.error.issues) fields[issue.path.join(".") || "params"] = issue.message;
    throw new DomainError("invalid_rule_params", `Invalid parameters for rule type "${type}".`, 422, fields);
  }
  return result.data as RuleParams<T>;
}

/** Same as parseRuleParams but returns null instead of throwing (for evaluating stored rules defensively). */
export function safeRuleParams<T extends RuleTypeId>(type: T, params: unknown): RuleParams<T> | null {
  const result = RULE_TYPES[type].params.safeParse(params ?? {});
  return result.success ? (result.data as RuleParams<T>) : null;
}

/** Serializable catalog for the rule editor UI (zod schemas converted to JSON Schema). */
export function ruleCatalog(orgKind?: OrgKind) {
  return RULE_TYPE_IDS.filter((t) => !orgKind || (RULE_TYPES[t].orgKinds as readonly OrgKind[]).includes(orgKind)).map((t) => ({
    type: t,
    label: RULE_TYPES[t].label,
    description: RULE_TYPES[t].description,
    needs: RULE_TYPES[t].needs,
    requires: [...RULE_TYPES[t].requires],
    orgKinds: [...RULE_TYPES[t].orgKinds],
    // JSON round-trip: zod's output is not a plain object, which React refuses
    // to pass from a Server Component to a Client Component.
    paramsSchema: JSON.parse(JSON.stringify(z.toJSONSchema(RULE_TYPES[t].params, { io: "input" }))) as Record<string, unknown>,
  }));
}
