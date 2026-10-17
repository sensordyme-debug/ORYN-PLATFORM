/**
 * Alert evaluation for one AOI: load stored data, run the pure rule
 * evaluators (evaluate.ts), and persist the resulting alerts.
 *
 * Guarantees
 *  - Idempotent: alerts are inserted with ON CONFLICT (org_id, dedupe_key)
 *    DO NOTHING, so re-evaluation and reprocessing never duplicate an alert.
 *  - Evaluations of one AOI are serialized (transaction advisory lock), so
 *    cooldown decisions cannot race.
 *  - Cooldown: a candidate for a rule + AOI that already produced a notified
 *    alert within cooldown_hours is stored as 'suppressed' (kept for
 *    history, never notified).
 *  - Reprocessing: when the evaluation was triggered by reprocessing, or an
 *    imagery-derived candidate's acquisition time is not newer than the
 *    newest acquisition already referenced by an alert for the same rule +
 *    AOI, the alert is marked from_reprocessing, says so in its title and
 *    explanation, and is never notified.
 *  - Each new alert gets an alert_events 'created' row, an audit row (actor
 *    system), and — when notifiable — a delivery job, all in the same
 *    transaction as the alert itself.
 */
import { JOB } from "@/server/jobs/types";
import { enqueueTx } from "@/server/jobs/queue";
import { recordAudit } from "@/server/audit";
import { uuidSchema } from "@/server/config/env";
import { jsonb, withTenant, type Tx } from "@/server/db/client";
import { log } from "@/server/log";
import { when } from "@/server/alerts/explain";
import {
  evaluateRule,
  type AlertCandidate,
  type EvalDetection,
  type EvalObservation,
  type EvalRule,
  type EvalWarning,
  type EvalWeather,
  type EvaluationData,
  type EvaluationNote,
  type WeatherKind,
} from "@/server/alerts/evaluate";
import { isRuleType, ruleTypesForTrigger, type RuleTypeId, type Severity, type TriggerKind } from "@/server/alerts/rules";
import type { ObservationQuality } from "@/server/analytics/types";

export type EvaluateTrigger = { kind: TriggerKind; ids?: string[] };

export type EvaluateAlertsInput = {
  orgId: string;
  aoiId: string;
  trigger: EvaluateTrigger;
  /** True when the pipeline is reprocessing data ORYN already had (new model version, re-run). */
  reprocessing?: boolean;
  /** True when the data is historical imagery loaded for the first time (AOI backfill), not a new acquisition. */
  historical?: boolean;
};

export type CreatedAlert = {
  id: string;
  ruleId: string;
  dedupeKey: string;
  status: "open" | "suppressed";
  fromReprocessing: boolean;
  /** Whether a delivery job was enqueued. */
  notify: boolean;
};

export type EvaluateAlertsResult = {
  /** New alerts that will be notified or are open (excludes suppressed). */
  created: number;
  /** New alerts stored as suppressed by the rule's cooldown. */
  suppressed: number;
  /** Candidates whose dedupe key already existed. */
  skipped: number;
  notes: EvaluationNote[];
  alerts: CreatedAlert[];
};

const OBSERVATION_LOOKBACK_DAYS = 400;
const DETECTION_LOOKBACK_DAYS = 30;
const WEATHER_LOOKBACK_DAYS = 100;
const WEATHER_VARIABLES_USED = ["precipitation_mm", "temperature_max_c", "temperature_c"];

type RuleRow = {
  id: string;
  name: string;
  rule_type: string;
  params: Record<string, unknown>;
  severity: Severity;
  created_at: Date;
  cooldown_hours: number;
};

type PriorStats = { rule_id: string; max_observed_at: Date | null; last_notifiable_at: Date | null };

export async function evaluateAlertsForAoi(input: EvaluateAlertsInput): Promise<EvaluateAlertsResult> {
  const result: EvaluateAlertsResult = { created: 0, suppressed: 0, skipped: 0, notes: [], alerts: [] };
  await withTenant({ orgId: input.orgId }, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`alerts.evaluate:${input.aoiId}`}))`;
    const [clock] = await tx<{ now: Date }[]>`select now() as now`;
    const now = clock!.now;

    const types = ruleTypesForTrigger(input.trigger.kind);
    const rules = (
      await tx<RuleRow[]>`
        select id, name, rule_type, params, severity, created_at, cooldown_hours
          from alert_rules
         where org_id = ${input.orgId} and enabled and (aoi_id is null or aoi_id = ${input.aoiId})
           and rule_type = any(${types})
         order by created_at, id`
    ).filter((r) => isRuleType(r.rule_type));
    if (rules.length === 0) return;

    const data = await loadEvaluationData(tx, input, now);
    if (!data) {
      result.notes.push(...rules.map((r) => ({ ruleId: r.id, ruleType: r.rule_type as RuleTypeId, code: "no_data" as const, message: "AOI not found or not active." })));
      return;
    }

    const prior = new Map(
      (
        await tx<PriorStats[]>`
          select rule_id,
                 max(observed_at) as max_observed_at,
                 max(created_at) filter (where status <> 'suppressed' and not from_reprocessing) as last_notifiable_at
            from alerts
           where org_id = ${input.orgId} and aoi_id = ${input.aoiId} and rule_id = any(${rules.map((r) => r.id)})
           group by rule_id`
      ).map((p) => [p.rule_id, p]),
    );

    for (const r of rules) {
      const rule: EvalRule = { id: r.id, name: r.name, ruleType: r.rule_type as RuleTypeId, params: r.params, severity: r.severity, createdAt: r.created_at };
      const evaluation = evaluateRule(rule, data);
      result.notes.push(...evaluation.notes);
      const stats = prior.get(r.id);
      // Snapshot before this run so several candidates from one new acquisition are all treated as new.
      const priorMaxObserved = stats?.max_observed_at ?? null;
      let lastNotifiable = stats?.last_notifiable_at ?? null;

      for (const c of evaluation.candidates) {
        const fromReprocessing =
          Boolean(input.reprocessing) ||
          Boolean(input.historical) ||
          (c.imageryDerived && c.observedAt != null && priorMaxObserved != null && c.observedAt.getTime() <= priorMaxObserved.getTime());
        const inCooldown = r.cooldown_hours > 0 && lastNotifiable != null && now.getTime() - lastNotifiable.getTime() < r.cooldown_hours * 3_600_000;
        const status = inCooldown ? "suppressed" : "open";
        const created = await persistCandidate(tx, input, c, { status, fromReprocessing, cooldownHours: r.cooldown_hours, now });
        if (!created) {
          result.skipped++;
          continue;
        }
        if (status === "suppressed") result.suppressed++;
        else result.created++;
        if (status === "open" && !fromReprocessing) lastNotifiable = now;
        result.alerts.push(created);
      }
    }
  });
  if (result.notes.length) log.debug("alerts.evaluate.notes", { aoiId: input.aoiId, notes: result.notes.slice(0, 20) });
  return result;
}

async function persistCandidate(
  tx: Tx,
  input: EvaluateAlertsInput,
  c: AlertCandidate,
  o: { status: "open" | "suppressed"; fromReprocessing: boolean; cooldownHours: number; now: Date },
): Promise<CreatedAlert | null> {
  const explanation = { ...c.explanation };
  let title = c.title;
  if (o.fromReprocessing && input.historical && !input.reprocessing) {
    explanation.reprocessing = `Produced while loading historical imagery (acquired ${when(c.observedAt)}) for this area for the first time. It is not a new observation, and no notifications were sent.`;
    title = `Historical data: ${title}`;
  } else if (o.fromReprocessing) {
    explanation.reprocessing = `Produced by reprocessing data acquired ${when(c.observedAt)} that ORYN had already received. It is not a new observation, and no notifications were sent.`;
    title = `Reprocessed data: ${title}`;
  }
  if (o.status === "suppressed") {
    explanation.suppressed_reason = `Another alert for this rule and AOI was raised within the ${o.cooldownHours}-hour cooldown. This alert is kept for history and was not notified.`;
  }
  const geom =
    c.geom.source === "detection"
      ? tx`(select geom from detections where id = ${c.geom.detectionId} and org_id = ${input.orgId})`
      : tx`(select geom from aois where id = ${input.aoiId} and org_id = ${input.orgId})`;

  const [row] = await tx<{ id: string }[]>`
    insert into alerts (org_id, rule_id, aoi_id, detection_id, observation_id, severity, status, title, explanation, geom,
                        event_at, observed_at, ingested_at, processed_at, from_reprocessing, dedupe_key)
    values (${input.orgId}, ${c.ruleId}, ${input.aoiId}, ${c.detectionId}, ${c.observationId}, ${c.severity}, ${o.status},
            ${title}, ${jsonb(explanation)}::jsonb, ${geom},
            ${c.eventAt}, ${c.observedAt}, ${c.ingestedAt}, ${c.processedAt}, ${o.fromReprocessing}, ${c.dedupeKey})
    on conflict (org_id, dedupe_key) do nothing
    returning id`;
  if (!row) return null;

  const reason = [o.fromReprocessing ? "from reprocessing (not notified)" : null, o.status === "suppressed" ? "suppressed by cooldown" : null]
    .filter(Boolean)
    .join("; ");
  await tx`
    insert into alert_events (org_id, alert_id, action, to_status, note)
    values (${input.orgId}, ${row.id}, 'created', ${o.status}, ${reason || null})`;
  await recordAudit(tx, {
    orgId: input.orgId,
    actor: { type: "system", label: "alerts.evaluate" },
    action: "alert.create",
    targetType: "alert",
    targetId: row.id,
    metadata: {
      rule_id: c.ruleId,
      rule_type: c.ruleType,
      dedupe_key: c.dedupeKey,
      status: o.status,
      from_reprocessing: o.fromReprocessing,
      trigger: input.trigger.kind,
    },
  });
  const notify = o.status === "open" && !o.fromReprocessing;
  if (notify) {
    await enqueueTx(tx, {
      orgId: input.orgId,
      type: JOB.alertsDeliver,
      payload: { alertId: row.id, reason: "created" },
      idempotencyKey: `alerts.deliver:${row.id}:created`,
      priority: 50,
    });
  }
  return { id: row.id, ruleId: c.ruleId, dedupeKey: c.dedupeKey, status: o.status, fromReprocessing: o.fromReprocessing, notify };
}

// ── Loading ────────────────────────────────────────────────────

type ObservationRow = {
  id: string;
  kind: string;
  model_id: string;
  model_version: string;
  result_class: string;
  status: "valid" | "unusable";
  observed_at: Date;
  processed_at: Date;
  metrics: Record<string, unknown>;
  quality: Partial<ObservationQuality>;
  limitations: string[];
  asset_id: string;
  provider_id: string;
  collection: string;
  platform: string | null;
  first_seen_at: Date | null;
};

function toObservation(r: ObservationRow): EvalObservation {
  return {
    id: r.id,
    kind: r.kind,
    modelId: r.model_id,
    modelVersion: r.model_version,
    resultClass: r.result_class,
    status: r.status,
    observedAt: r.observed_at,
    processedAt: r.processed_at,
    ingestedAt: r.first_seen_at,
    assetId: r.asset_id,
    providerId: r.provider_id,
    collection: r.collection,
    platform: r.platform,
    metrics: r.metrics ?? {},
    quality: r.quality ?? {},
    limitations: r.limitations ?? [],
  };
}

/** Load everything the rule evaluators read for one AOI. Null when the AOI is missing or archived. */
export async function loadEvaluationData(tx: Tx, input: EvaluateAlertsInput, now: Date): Promise<EvaluationData | null> {
  const { orgId, aoiId, trigger } = input;
  const [aoi] = await tx<{ id: string; name: string; area_m2: number; created_at: Date; lon: number | null; lat: number | null }[]>`
    select id, name, area_m2, created_at, ST_X(label_point) as lon, ST_Y(label_point) as lat
      from aois where id = ${aoiId} and org_id = ${orgId} and status = 'active'`;
  if (!aoi) return null;

  const obsColumns = tx`
    o.id, o.kind, o.model_id, o.model_version, o.result_class, o.status, o.observed_at, o.processed_at,
    o.metrics, o.quality, o.limitations, o.asset_id, s.provider_id, s.collection, s.platform, s.first_seen_at`;
  const observations = await tx<ObservationRow[]>`
    select ${obsColumns}
      from observations o join source_assets s on s.id = o.asset_id
     where o.org_id = ${orgId} and o.aoi_id = ${aoiId} and o.is_current
       and o.observed_at >= ${now}::timestamptz - make_interval(days => ${OBSERVATION_LOOKBACK_DAYS})
     order by o.observed_at desc
     limit 2000`;
  const latestValid = await tx<ObservationRow[]>`
    select distinct on (o.kind) ${obsColumns}
      from observations o join source_assets s on s.id = o.asset_id
     where o.org_id = ${orgId} and o.aoi_id = ${aoiId} and o.is_current and o.status = 'valid'
     order by o.kind, o.observed_at desc`;

  // Trigger ids narrow detections / warnings to the rows that caused the evaluation (non-UUIDs match nothing).
  const uuidsOnly = (ids: string[]) => ids.filter((id) => uuidSchema.safeParse(id).success);
  const detectionIds = trigger.kind === "detection" && trigger.ids?.length ? uuidsOnly(trigger.ids) : null;
  const detections = await tx<
    {
      id: string;
      type: string;
      result_class: string;
      title: string;
      area_m2: number | null;
      lon: number | null;
      lat: number | null;
      evidence_grade: string;
      evidence_reasons: string[];
      verification_status: string;
      model_id: string | null;
      model_version: string | null;
      metrics: Record<string, unknown>;
      baseline_observation_id: string | null;
      comparison_observation_id: string | null;
      baseline_observed_at: Date | null;
      comparison_observed_at: Date | null;
      last_observed_at: Date;
      source_asset_ids: string[];
      limitations: string[];
      created_at: Date;
      ingested_at: Date | null;
    }[]
  >`
    select d.id, d.type, d.result_class, d.title, d.area_m2,
           ST_X(ST_PointOnSurface(d.geom)) as lon, ST_Y(ST_PointOnSurface(d.geom)) as lat,
           d.evidence_grade, d.evidence_reasons, d.verification_status, d.model_id, d.model_version, d.metrics,
           d.baseline_observation_id, d.comparison_observation_id, d.baseline_observed_at, d.comparison_observed_at,
           d.last_observed_at, d.source_asset_ids, d.limitations, d.created_at,
           (select max(s.first_seen_at) from source_assets s where s.id = any(d.source_asset_ids)) as ingested_at
      from detections d
     where d.org_id = ${orgId} and d.aoi_id = ${aoiId}
       and ${detectionIds ? tx`d.id = any(${detectionIds}::uuid[])` : tx`d.created_at >= ${now}::timestamptz - make_interval(days => ${DETECTION_LOOKBACK_DAYS})`}
     order by d.created_at, d.id`;

  const weather = await tx<
    {
      id: string;
      provider_id: string;
      record_kind: WeatherKind;
      variable: string;
      value: number | null;
      unit: string;
      valid_from: Date;
      valid_to: Date;
      issued_at: Date | null;
      retrieved_at: Date;
      station_id: string | null;
      station_distance_km: number | null;
    }[]
  >`
    select id::text as id, provider_id, record_kind, variable, value, unit, valid_from, valid_to, issued_at, retrieved_at,
           station_id, station_distance_km
      from weather_records
     where org_id = ${orgId} and aoi_id = ${aoiId} and variable = any(${WEATHER_VARIABLES_USED})
       and valid_from >= ${now}::timestamptz - make_interval(days => ${WEATHER_LOOKBACK_DAYS})
       and valid_from <= ${now}::timestamptz + interval '20 days'`;

  const warningIds = trigger.kind === "warning" && trigger.ids?.length ? uuidsOnly(trigger.ids) : null;
  const warnings = await tx<
    {
      id: string;
      provider_id: string;
      title: string;
      severity: string | null;
      certainty: string | null;
      urgency: string | null;
      category: string | null;
      event_start: Date | null;
      event_end: Date | null;
      published_at: Date | null;
      retrieved_at: Date;
      source_url: string | null;
      claim_status: string;
    }[]
  >`
    select id, provider_id, title, severity, certainty, urgency, category, event_start, event_end, published_at,
           retrieved_at, source_url, claim_status
      from external_events
     where org_id = ${orgId} and aoi_id = ${aoiId} and event_kind = 'weather_warning'
       and (event_end is null or event_end > ${now})
       ${warningIds ? tx`and id = any(${warningIds}::uuid[])` : tx``}
     order by published_at nulls last, id`;

  return {
    now,
    aoi: {
      id: aoi.id,
      name: aoi.name,
      areaM2: aoi.area_m2,
      centroid: aoi.lon != null && aoi.lat != null ? [aoi.lon, aoi.lat] : null,
      createdAt: aoi.created_at,
    },
    observations: observations.map(toObservation),
    latestValidByKind: latestValid.map(toObservation),
    detections: detections.map(
      (d): EvalDetection => ({
        id: d.id,
        type: d.type,
        resultClass: d.result_class,
        title: d.title,
        areaM2: d.area_m2,
        centroid: d.lon != null && d.lat != null ? [d.lon, d.lat] : null,
        evidenceGrade: d.evidence_grade,
        evidenceReasons: d.evidence_reasons ?? [],
        verificationStatus: d.verification_status,
        modelId: d.model_id,
        modelVersion: d.model_version,
        metrics: d.metrics ?? {},
        baselineObservationId: d.baseline_observation_id,
        comparisonObservationId: d.comparison_observation_id,
        baselineObservedAt: d.baseline_observed_at,
        comparisonObservedAt: d.comparison_observed_at,
        lastObservedAt: d.last_observed_at,
        sourceAssetIds: d.source_asset_ids ?? [],
        limitations: d.limitations ?? [],
        createdAt: d.created_at,
        ingestedAt: d.ingested_at,
      }),
    ),
    weather: weather.map(
      (w): EvalWeather => ({
        id: w.id,
        providerId: w.provider_id,
        recordKind: w.record_kind,
        variable: w.variable,
        value: w.value,
        unit: w.unit,
        validFrom: w.valid_from,
        validTo: w.valid_to,
        issuedAt: w.issued_at,
        retrievedAt: w.retrieved_at,
        stationId: w.station_id,
        stationDistanceKm: w.station_distance_km,
      }),
    ),
    warnings: warnings.map(
      (w): EvalWarning => ({
        id: w.id,
        providerId: w.provider_id,
        title: w.title,
        severity: w.severity,
        certainty: w.certainty,
        urgency: w.urgency,
        category: w.category,
        eventStart: w.event_start,
        eventEnd: w.event_end,
        publishedAt: w.published_at,
        retrievedAt: w.retrieved_at,
        sourceUrl: w.source_url,
        claimStatus: w.claim_status,
      }),
    ),
  };
}
