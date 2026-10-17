/**
 * Data fixtures for the alerting / reports / exports / retention
 * integration tests. Inserted through the OWNER connection (bypassing RLS)
 * with the stored shapes from src/server/analytics/types.ts; the code under
 * test always runs as the application role.
 */
import { randomUUID } from "node:crypto";
import type { OrgRole } from "@/lib/authz";
import { resolveUserOrgAccess, type OrgAccess } from "@/server/authz/access";
import { addMember, createUser, meta, ownerSql } from "../helpers/db";

const DAY = 86_400_000;
export const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
/**
 * `n` days before the DATABASE clock. Use it when the code under test
 * measures an age against the database's now() and floors it to whole days:
 * the test host and PostgreSQL (in a VM) keep separate clocks, so a Node-side
 * daysAgo(30) can read as 29 days when the database clock lags by a few ms.
 */
export async function dbDaysAgo(n: number): Promise<Date> {
  const [r] = await ownerSql()<{ t: Date }[]>`select now() - make_interval(secs => ${n * 86_400}) as t`;
  return r!.t;
}
const json = (v: unknown) => ownerSql().json(JSON.parse(JSON.stringify(v)));

export async function member(org: { id: string; slug: string }, role: OrgRole, aoiRestricted = false) {
  const u = await createUser(`${role}-${randomUUID().slice(0, 6)}@example.test`, `${role} user`);
  const membershipId = await addMember(org.id, u.id, role, aoiRestricted);
  const access = await resolveUserOrgAccess({ id: u.id, label: u.email, isPlatformAdmin: false }, org.slug, meta);
  return { ...u, membershipId, access };
}

export async function refreshAccess(user: { id: string; email: string }, slug: string): Promise<OrgAccess> {
  return resolveUserOrgAccess({ id: user.id, label: user.email, isPlatformAdmin: false }, slug, meta);
}

export async function grantAoi(orgId: string, membershipId: string, aoiId: string) {
  await ownerSql()`insert into aoi_grants (org_id, membership_id, aoi_id) values (${orgId}, ${membershipId}, ${aoiId})`;
}

export async function insertAsset(o: { collection?: string; acquiredAt: Date; attribution?: string | null; license?: string | null; providerId?: string }) {
  const [a] = await ownerSql()<{ id: string }[]>`
    insert into source_assets (provider_id, collection, external_id, kind, platform, acquired_at, footprint, cloud_cover, gsd_m, epsg,
                               license, license_url, attribution, metadata_hash, first_seen_at)
    values (${o.providerId ?? "earth-search"}, ${o.collection ?? "sentinel-2-l2a"}, ${`S2_${randomUUID()}`}, 'optical', 'sentinel-2b',
            ${o.acquiredAt}, ST_SetSRID(ST_MakeEnvelope(-78, 35, -77, 36), 4326), 5, 10, 32618,
            ${o.license ?? "proprietary"}, 'https://sentinel.esa.int/documents/247904/690755/Sentinel_Data_Legal_Notice',
            ${o.attribution ?? null}, ${randomUUID()}, ${new Date(o.acquiredAt.getTime() + 6 * 3_600_000)})
    returning id`;
  return a!.id;
}

export async function insertRun(orgId: string, aoiId: string, modelId = "ndvi", status = "succeeded", extra: { messages?: string[]; error?: string | null } = {}) {
  const [r] = await ownerSql()<{ id: string }[]>`
    insert into processing_runs (org_id, aoi_id, model_id, model_version, status, software_version, finished_at, messages, error)
    values (${orgId}, ${aoiId}, ${modelId}, '1.0.0', ${status}, 'test', now(), ${extra.messages ?? []}, ${extra.error ?? null})
    returning id`;
  return r!.id;
}

export type ObsOptions = {
  observedAt: Date;
  mean?: number;
  status?: "valid" | "unusable";
  unusableReason?: string;
  kind?: string;
  modelId?: string;
  collection?: string;
  metrics?: Record<string, unknown>;
  raster?: Record<string, unknown> | null;
  isCurrent?: boolean;
  assetId?: string;
};

export async function insertObservation(orgId: string, aoiId: string, o: ObsOptions) {
  const assetId = o.assetId ?? (await insertAsset({ acquiredAt: o.observedAt, collection: o.collection }));
  const modelId = o.modelId ?? "ndvi";
  const runId = await insertRun(orgId, aoiId, modelId);
  const status = o.status ?? "valid";
  const metrics =
    o.metrics ??
    (status === "valid"
      ? { mean: o.mean ?? 0.6, median: o.mean ?? 0.6, p10: (o.mean ?? 0.6) - 0.1, p90: (o.mean ?? 0.6) + 0.1, std: 0.05, min: 0, max: 0.9, valid_pixels: 9000, total_pixels: 10000, valid_fraction: 0.9, masked_fraction: 0.1, pixel_area_m2: 100, histogram: { min: -1, max: 1, counts: [1, 2, 3] } }
      : { valid_fraction: 0.05, valid_pixels: 500, total_pixels: 10000 });
  const quality = {
    coverage_fraction: 1,
    scene_cloud_cover: status === "valid" ? 4 : 91,
    masked_fraction: status === "valid" ? 0.1 : 0.95,
    flags: status === "valid" ? [] : ["below_min_valid_fraction"],
    gsd_m: 10,
    ...(status === "unusable" ? { unusable_reason: o.unusableReason ?? "95% of AOI pixels masked as cloud" } : {}),
  };
  const [row] = await ownerSql()<{ id: string }[]>`
    insert into observations (org_id, aoi_id, run_id, asset_id, model_id, model_version, kind, result_class, observed_at, processed_at,
                              status, metrics, quality, raster, limitations, is_current)
    values (${orgId}, ${aoiId}, ${runId}, ${assetId}, ${modelId}, '1.0.0', ${o.kind ?? "ndvi"}, 'deterministic_calculation',
            ${o.observedAt}, ${new Date(o.observedAt.getTime() + 8 * 3_600_000)}, ${status}, ${json(metrics)}, ${json(quality)},
            ${o.raster ? json(o.raster) : null}, '{}', ${o.isCurrent ?? true})
    returning id`;
  return { id: row!.id, assetId, runId };
}

export async function insertDetection(
  orgId: string,
  aoiId: string,
  o: { type?: string; areaM2?: number; grade?: string; verification?: string; observedAt?: Date; modelId?: string; metrics?: Record<string, unknown>; assetIds?: string[] } = {},
) {
  const observedAt = o.observedAt ?? daysAgo(2);
  const [d] = await ownerSql()<{ id: string }[]>`
    insert into detections (org_id, aoi_id, type, result_class, title, geom, area_m2, baseline_observed_at, comparison_observed_at,
                            first_observed_at, last_observed_at, source_asset_ids, model_id, model_version, metrics, thresholds,
                            evidence_grade, evidence_reasons, limitations, verification_status, dedupe_key)
    values (${orgId}, ${aoiId}, ${o.type ?? "vegetation_loss"}, 'candidate_change', 'Vegetation decrease',
            ST_SetSRID(ST_MakeEnvelope(-77.599, 35.901, -77.597, 35.903), 4326), ${o.areaM2 ?? 4000},
            ${new Date(observedAt.getTime() - 10 * DAY)}, ${observedAt}, ${observedAt}, ${observedAt}, ${o.assetIds ?? []},
            ${o.modelId ?? "ndvi-change"}, '1.0.0', ${json(o.metrics ?? { direction: "decrease", mean_delta: -0.3, area_m2: o.areaM2 ?? 4000 })},
            ${json({ threshold: 0.2 })}, ${o.grade ?? "strong"}, ${["same grid", "90% valid overlap"]}, '{}',
            ${o.verification ?? "unverified"}, ${`det:${randomUUID()}`})
    returning id`;
  return d!.id;
}

export async function insertWeather(
  orgId: string,
  aoiId: string,
  o: { day: string; value: number; kind?: "observation" | "model_estimate" | "forecast"; variable?: string; providerId?: string; unit?: string },
) {
  const from = new Date(`${o.day}T00:00:00Z`);
  const kind = o.kind ?? "observation";
  await ownerSql()`
    insert into weather_records (org_id, aoi_id, provider_id, record_kind, variable, value, unit, valid_from, valid_to, issued_at, retrieved_at, station_distance_km)
    values (${orgId}, ${aoiId}, ${o.providerId ?? (kind === "forecast" ? "open-meteo" : "noaa-ghcnd")}, ${kind}, ${o.variable ?? "precipitation_mm"},
            ${o.value}, ${o.unit ?? "mm"}, ${from}, ${new Date(from.getTime() + DAY)}, ${kind === "forecast" ? daysAgo(0.2) : null}, now(),
            ${kind === "observation" ? 6.5 : null})`;
}

export async function insertWarning(orgId: string, aoiId: string, o: { severity?: string; title?: string; endsInHours?: number } = {}) {
  const [w] = await ownerSql()<{ id: string }[]>`
    insert into external_events (org_id, aoi_id, provider_id, event_kind, external_id, title, severity, certainty, urgency,
                                 event_start, event_end, published_at, source_url, claim_status)
    values (${orgId}, ${aoiId}, 'nws', 'weather_warning', ${randomUUID()}, ${o.title ?? "Flash Flood Warning"}, ${o.severity ?? "Severe"},
            'Likely', 'Immediate', now() + interval '1 hour', now() + make_interval(hours => ${o.endsInHours ?? 12}), now() - interval '10 minutes',
            'https://api.weather.gov/alerts/test', 'official_warning')
    returning id`;
  return w!.id;
}

export async function insertRule(
  orgId: string,
  ruleType: string,
  params: Record<string, unknown>,
  o: {
    aoiId?: string | null;
    cooldownHours?: number;
    notifyEmail?: boolean;
    notifyRoles?: OrgRole[];
    escalateAfterHours?: number | null;
    escalateToRoles?: OrgRole[];
    createdAt?: Date;
    severity?: string;
  } = {},
) {
  const [r] = await ownerSql()<{ id: string }[]>`
    insert into alert_rules (org_id, name, aoi_id, rule_type, params, severity, notify_email, notify_roles, cooldown_hours,
                             escalate_after_hours, escalate_to_roles, created_at)
    values (${orgId}, ${`Rule ${ruleType}`}, ${o.aoiId ?? null}, ${ruleType}, ${json(params)}, ${o.severity ?? "high"}, ${o.notifyEmail ?? false},
            ${o.notifyRoles ?? ["org_admin", "analyst"]}::org_role[], ${o.cooldownHours ?? 24}, ${o.escalateAfterHours ?? null},
            ${o.escalateToRoles ?? ["org_admin"]}::org_role[], ${o.createdAt ?? daysAgo(30)})
    returning id`;
  return r!.id;
}

export async function rows<T = Record<string, unknown>>(query: TemplateStringsArray, ...args: unknown[]): Promise<T[]> {
  return (await ownerSql()(query, ...(args as never[]))) as unknown as T[];
}
