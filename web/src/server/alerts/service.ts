/**
 * Alert lifecycle: list, get (with expanded evidence and history),
 * acknowledge, assign, resolve, reopen, and notes.
 *
 * Guarantees
 *  - Every function takes an OrgAccess and asserts the needed permission.
 *  - Alerts outside the caller's org — or outside their granted AOIs for
 *    aoi_restricted members — are indistinguishable from missing (404).
 *  - Every mutation writes an alert_events row and an audit_events row in
 *    the same transaction as the change.
 */
import { z } from "zod";
import type { OrgAccess } from "@/server/authz/access";
import { recordAudit } from "@/server/audit";
import { uuidSchema } from "@/server/config/env";
import type { Tx } from "@/server/db/client";
import { DomainError, notFoundError } from "@/server/errors";
import type { AlertEvidence, AlertExplanation } from "@/server/alerts/explain";
import { SEVERITIES, type Severity } from "@/server/alerts/rules";
import { memberCanSeeAoi, visibleAoiIds } from "@/server/alerts/scope";

export const ALERT_STATUSES = ["open", "acknowledged", "resolved", "suppressed"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export type AlertSummary = {
  id: string;
  ruleId: string | null;
  ruleName: string | null;
  ruleType: string | null;
  aoiId: string;
  aoiName: string;
  severity: Severity;
  status: AlertStatus;
  title: string;
  basis: string | null;
  eventAt: Date | null;
  observedAt: Date | null;
  ingestedAt: Date | null;
  processedAt: Date | null;
  createdAt: Date;
  notifiedAt: Date | null;
  fromReprocessing: boolean;
  assignedTo: string | null;
  escalationLevel: number;
};

export type AlertEventEntry = {
  id: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  note: string | null;
  actorUserId: string | null;
  actorName: string | null;
  createdAt: Date;
};

export type AlertNote = { id: string; body: string; authorId: string | null; authorName: string | null; createdAt: Date };

export type ExpandedEvidence = AlertEvidence & {
  /** The current stored row(s); empty when the source row no longer exists (e.g. removed by retention). */
  records: Record<string, unknown>[];
};

export type AlertDetail = AlertSummary & {
  explanation: AlertExplanation;
  evidence: ExpandedEvidence[];
  geometry: unknown | null;
  detectionId: string | null;
  observationId: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: Date | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  escalatedAt: Date | null;
  events: AlertEventEntry[];
  notes: AlertNote[];
};

export type AlertListFilters = {
  status?: AlertStatus[];
  severity?: Severity[];
  aoiId?: string;
  ruleId?: string;
  /** created_at >= from (Date or ISO string) */
  from?: Date | string;
  /** created_at < to (Date or ISO string) */
  to?: Date | string;
  cursor?: string | null;
  limit?: number;
};

const filtersSchema = z.object({
  status: z.array(z.enum(ALERT_STATUSES)).max(4).optional(),
  severity: z.array(z.enum(SEVERITIES)).max(5).optional(),
  aoiId: uuidSchema.optional(),
  ruleId: uuidSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().max(200).nullish(),
  limit: z.number().int().min(1).max(200).optional(),
});

type AlertRow = {
  id: string;
  rule_id: string | null;
  rule_name: string | null;
  rule_type: string | null;
  aoi_id: string;
  aoi_name: string;
  severity: Severity;
  status: AlertStatus;
  title: string;
  explanation: AlertExplanation;
  event_at: Date | null;
  observed_at: Date | null;
  ingested_at: Date | null;
  processed_at: Date | null;
  created_at: Date;
  notified_at: Date | null;
  from_reprocessing: boolean;
  assigned_to: string | null;
  escalation_level: number;
};

function toSummary(r: AlertRow): AlertSummary {
  return {
    id: r.id,
    ruleId: r.rule_id,
    ruleName: r.rule_name,
    ruleType: r.rule_type,
    aoiId: r.aoi_id,
    aoiName: r.aoi_name,
    severity: r.severity,
    status: r.status,
    title: r.title,
    basis: r.explanation?.basis ?? null,
    eventAt: r.event_at,
    observedAt: r.observed_at,
    ingestedAt: r.ingested_at,
    processedAt: r.processed_at,
    createdAt: r.created_at,
    notifiedAt: r.notified_at,
    fromReprocessing: r.from_reprocessing,
    assignedTo: r.assigned_to,
    escalationLevel: r.escalation_level,
  };
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id])).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const [t, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as [string, string];
    const createdAt = new Date(t);
    if (Number.isNaN(createdAt.getTime()) || !uuidSchema.safeParse(id).success) throw new Error("bad cursor");
    return { createdAt, id };
  } catch {
    throw new DomainError("invalid_cursor", "Invalid pagination cursor.", 400);
  }
}

const SUMMARY_COLUMNS = (tx: Tx) => tx`
  a.id, a.rule_id, r.name as rule_name, r.rule_type, a.aoi_id, ao.name as aoi_name, a.severity, a.status, a.title,
  a.explanation, a.event_at, a.observed_at, a.ingested_at, a.processed_at, a.created_at, a.notified_at,
  a.from_reprocessing, a.assigned_to, a.escalation_level`;

/** List alerts, newest first, with keyset pagination on (created_at, id). */
export async function listAlerts(access: OrgAccess, filters: AlertListFilters = {}): Promise<{ items: AlertSummary[]; nextCursor: string | null }> {
  access.assert("alerts.read");
  const f = filtersSchema.parse(filters);
  const limit = f.limit ?? 50;
  const cursor = f.cursor ? decodeCursor(f.cursor) : null;
  return access.tx(async (tx) => {
    const visible = await visibleAoiIds(tx, access);
    const rows = await tx<AlertRow[]>`
      select ${SUMMARY_COLUMNS(tx)}
        from alerts a
        join aois ao on ao.id = a.aoi_id
        left join alert_rules r on r.id = a.rule_id
       where a.org_id = ${access.org.id}
         ${visible ? tx`and a.aoi_id = any(${visible}::uuid[])` : tx``}
         ${f.status?.length ? tx`and a.status = any(${f.status})` : tx``}
         ${f.severity?.length ? tx`and a.severity = any(${f.severity})` : tx``}
         ${f.aoiId ? tx`and a.aoi_id = ${f.aoiId}` : tx``}
         ${f.ruleId ? tx`and a.rule_id = ${f.ruleId}` : tx``}
         ${f.from ? tx`and a.created_at >= ${f.from}` : tx``}
         ${f.to ? tx`and a.created_at < ${f.to}` : tx``}
         ${cursor ? tx`and (a.created_at, a.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : tx``}
       order by a.created_at desc, a.id desc
       limit ${limit + 1}`;
    const items = rows.slice(0, limit).map(toSummary);
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return { items, nextCursor: last ? encodeCursor(last.created_at, last.id) : null };
  });
}

type FullAlertRow = AlertRow & {
  detection_id: string | null;
  observation_id: string | null;
  geometry: unknown | null;
  acknowledged_by: string | null;
  acknowledged_at: Date | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  resolution_note: string | null;
  escalated_at: Date | null;
};

async function findAlert(tx: Tx, access: OrgAccess, alertId: string, forUpdate = false): Promise<FullAlertRow> {
  if (!uuidSchema.safeParse(alertId).success) throw notFoundError("Alert");
  const [row] = await tx<FullAlertRow[]>`
    select ${SUMMARY_COLUMNS(tx)}, a.detection_id, a.observation_id, ST_AsGeoJSON(a.geom)::jsonb as geometry,
           a.acknowledged_by, a.acknowledged_at, a.resolved_by, a.resolved_at, a.resolution_note, a.escalated_at
      from alerts a
      join aois ao on ao.id = a.aoi_id
      left join alert_rules r on r.id = a.rule_id
     where a.id = ${alertId} and a.org_id = ${access.org.id}
     ${forUpdate ? tx`for update of a` : tx``}`;
  if (!row) throw notFoundError("Alert");
  const visible = await visibleAoiIds(tx, access);
  if (visible && !visible.includes(row.aoi_id)) throw notFoundError("Alert");
  return row;
}

/** One alert with evidence rows expanded, event history, and notes. */
export async function getAlert(access: OrgAccess, alertId: string): Promise<AlertDetail> {
  access.assert("alerts.read");
  return access.tx(async (tx) => {
    const row = await findAlert(tx, access, alertId);
    const evidence = await expandEvidence(tx, access.org.id, row.explanation?.evidence ?? []);
    const events = await tx<
      { id: string; action: string; from_status: string | null; to_status: string | null; note: string | null; actor_user_id: string | null; actor_name: string | null; created_at: Date }[]
    >`
      select e.id::text as id, e.action, e.from_status, e.to_status, e.note, e.actor_user_id, u.name as actor_name, e.created_at
        from alert_events e left join auth_user u on u.id = e.actor_user_id
       where e.org_id = ${access.org.id} and e.alert_id = ${row.id}
       order by e.created_at, e.id`;
    const notes = await tx<{ id: string; body: string; author_id: string | null; author_name: string | null; created_at: Date }[]>`
      select n.id, n.body, n.author_id, u.name as author_name, n.created_at
        from notes n left join auth_user u on u.id = n.author_id
       where n.org_id = ${access.org.id} and n.target_type = 'alert' and n.target_id = ${row.id}
       order by n.created_at, n.id`;
    return {
      ...toSummary(row),
      explanation: row.explanation,
      evidence,
      geometry: row.geometry,
      detectionId: row.detection_id,
      observationId: row.observation_id,
      acknowledgedBy: row.acknowledged_by,
      acknowledgedAt: row.acknowledged_at,
      resolvedBy: row.resolved_by,
      resolvedAt: row.resolved_at,
      resolutionNote: row.resolution_note,
      escalatedAt: row.escalated_at,
      events: events.map((e) => ({
        id: e.id,
        action: e.action,
        fromStatus: e.from_status,
        toStatus: e.to_status,
        note: e.note,
        actorUserId: e.actor_user_id,
        actorName: e.actor_name,
        createdAt: e.created_at,
      })),
      notes: notes.map((n) => ({ id: n.id, body: n.body, authorId: n.author_id, authorName: n.author_name, createdAt: n.created_at })),
    };
  });
}

/** Fetch the current rows behind an alert's evidence list (always filtered to the org). */
export async function expandEvidence(tx: Tx, orgId: string, evidence: AlertEvidence[]): Promise<ExpandedEvidence[]> {
  const idsOf = (type: AlertEvidence["type"]) => [...new Set(evidence.filter((e) => e.type === type).flatMap((e) => e.ids ?? [e.id]))];
  const uuids = (xs: string[]) => xs.filter((x) => uuidSchema.safeParse(x).success);
  const byId = new Map<string, Record<string, unknown>>();
  const put = (prefix: string, rows: Record<string, unknown>[]) => rows.forEach((r) => byId.set(`${prefix}:${String(r.id)}`, r));

  const obsIds = uuids(idsOf("observation"));
  if (obsIds.length) {
    put("observation", await tx`
      select o.id, o.kind, o.model_id, o.model_version, o.result_class, o.status, o.observed_at, o.processed_at,
             o.metrics, o.quality, o.is_current, o.asset_id, s.collection, s.provider_id
        from observations o join source_assets s on s.id = o.asset_id
       where o.org_id = ${orgId} and o.id = any(${obsIds}::uuid[])`);
  }
  const detIds = uuids(idsOf("detection"));
  if (detIds.length) {
    put("detection", await tx`
      select id, type, result_class, title, area_m2, evidence_grade, evidence_reasons, verification_status,
             model_id, model_version, baseline_observed_at, comparison_observed_at, metrics, created_at
        from detections where org_id = ${orgId} and id = any(${detIds}::uuid[])`);
  }
  const weatherIds = idsOf("weather").filter((x) => /^\d{1,18}$/.test(x));
  if (weatherIds.length) {
    put("weather", await tx`
      select id::text as id, provider_id, record_kind, variable, value, unit, valid_from, valid_to, issued_at, retrieved_at,
             station_id, station_distance_km, source_url
        from weather_records where org_id = ${orgId} and id = any(${weatherIds}::bigint[])`);
  }
  const warnIds = uuids(idsOf("warning"));
  if (warnIds.length) {
    put("warning", await tx`
      select id, provider_id, event_kind, title, severity, certainty, urgency, category, event_start, event_end,
             published_at, retrieved_at, source_url, claim_status
        from external_events where org_id = ${orgId} and id = any(${warnIds}::uuid[])`);
  }
  const assetIds = uuids(idsOf("source_asset"));
  if (assetIds.length) {
    // Catalog metadata (not tenant-owned); only assets the evidence list names are read.
    put("source_asset", await tx`
      select id, provider_id, collection, external_id, platform, acquired_at, cloud_cover, gsd_m,
             license, license_url, attribution, stac_url
        from source_assets where id = any(${assetIds}::uuid[])`);
  }
  return evidence.map((e) => ({
    ...e,
    records: (e.ids ?? [e.id]).map((id) => byId.get(`${e.type}:${id}`)).filter((r): r is Record<string, unknown> => Boolean(r)),
  }));
}

// ── Mutations ──────────────────────────────────────────────────

function actorUserId(access: OrgAccess): string | null {
  return access.principal.type === "user" ? access.principal.userId : null;
}

type AlertAction = "acknowledge" | "assign" | "unassign" | "resolve" | "reopen" | "note_add";

/** alert_events.action values (past tense, alongside the pipeline's 'created' and 'escalated'). */
const EVENT_ACTION: Record<AlertAction, string> = {
  acknowledge: "acknowledged",
  assign: "assigned",
  unassign: "unassigned",
  resolve: "resolved",
  reopen: "reopened",
  note_add: "note_added",
};

async function recordAlertChange(
  tx: Tx,
  access: OrgAccess,
  alert: FullAlertRow,
  e: { action: AlertAction; toStatus: string | null; note?: string | null; metadata?: Record<string, unknown> },
) {
  await tx`
    insert into alert_events (org_id, alert_id, actor_user_id, action, from_status, to_status, note)
    values (${access.org.id}, ${alert.id}, ${actorUserId(access)}, ${EVENT_ACTION[e.action]}, ${alert.status}, ${e.toStatus}, ${e.note ?? null})`;
  await recordAudit(tx, {
    orgId: access.org.id,
    actor: access.auditActor(),
    action: `alert.${e.action}`,
    targetType: "alert",
    targetId: alert.id,
    metadata: { from_status: alert.status, to_status: e.toStatus, ...(e.metadata ?? {}) },
    ip: access.meta.ip,
    userAgent: access.meta.userAgent,
  });
}

function assertTransition(alert: FullAlertRow, allowed: AlertStatus[], verb: string) {
  if (!allowed.includes(alert.status)) {
    throw new DomainError("invalid_transition", `An alert that is ${alert.status} cannot be ${verb}.`, 409);
  }
}

const noteText = z.string().trim().min(1, "A note is required.").max(4000);

export async function acknowledgeAlert(access: OrgAccess, alertId: string, note?: string | null): Promise<AlertSummary> {
  access.assert("alerts.respond");
  const text = note ? noteText.parse(note) : null;
  return access.tx(async (tx) => {
    const alert = await findAlert(tx, access, alertId, true);
    assertTransition(alert, ["open", "suppressed"], "acknowledged");
    await tx`
      update alerts set status = 'acknowledged', acknowledged_by = ${actorUserId(access)}, acknowledged_at = now()
       where id = ${alert.id} and org_id = ${access.org.id}`;
    await recordAlertChange(tx, access, alert, { action: "acknowledge", toStatus: "acknowledged", note: text });
    return toSummary({ ...alert, status: "acknowledged" });
  });
}

/** Assign (or unassign with null). The assignee must be an org member who can see the alert's AOI. */
export async function assignAlert(access: OrgAccess, alertId: string, assigneeUserId: string | null): Promise<AlertSummary> {
  access.assert("alerts.respond");
  return access.tx(async (tx) => {
    const alert = await findAlert(tx, access, alertId, true);
    if (assigneeUserId !== null) {
      const ok = typeof assigneeUserId === "string" && assigneeUserId.length > 0 && (await memberCanSeeAoi(tx, access.org.id, assigneeUserId, alert.aoi_id));
      if (!ok) {
        throw new DomainError("invalid_assignee", "The assignee must be a member of this organization with access to the alert's area.", 422, {
          assigneeUserId: "Not a member with access to this area.",
        });
      }
    }
    await tx`update alerts set assigned_to = ${assigneeUserId} where id = ${alert.id} and org_id = ${access.org.id}`;
    await recordAlertChange(tx, access, alert, {
      action: assigneeUserId ? "assign" : "unassign",
      toStatus: alert.status,
      metadata: { from_assignee: alert.assigned_to, to_assignee: assigneeUserId },
    });
    return toSummary({ ...alert, assigned_to: assigneeUserId });
  });
}

export async function resolveAlert(access: OrgAccess, alertId: string, note: string): Promise<AlertSummary> {
  access.assert("alerts.respond");
  const parsed = noteText.safeParse(note ?? "");
  if (!parsed.success) throw new DomainError("note_required", "A resolution note is required.", 422, { note: "A resolution note is required." });
  return access.tx(async (tx) => {
    const alert = await findAlert(tx, access, alertId, true);
    assertTransition(alert, ["open", "acknowledged", "suppressed"], "resolved");
    await tx`
      update alerts set status = 'resolved', resolved_by = ${actorUserId(access)}, resolved_at = now(), resolution_note = ${parsed.data}
       where id = ${alert.id} and org_id = ${access.org.id}`;
    await recordAlertChange(tx, access, alert, { action: "resolve", toStatus: "resolved", note: parsed.data });
    return toSummary({ ...alert, status: "resolved" });
  });
}

export async function reopenAlert(access: OrgAccess, alertId: string, note?: string | null): Promise<AlertSummary> {
  access.assert("alerts.respond");
  const text = note ? noteText.parse(note) : null;
  return access.tx(async (tx) => {
    const alert = await findAlert(tx, access, alertId, true);
    assertTransition(alert, ["acknowledged", "resolved", "suppressed"], "reopened");
    await tx`
      update alerts set status = 'open', acknowledged_by = null, acknowledged_at = null,
                        resolved_by = null, resolved_at = null, resolution_note = null
       where id = ${alert.id} and org_id = ${access.org.id}`;
    await recordAlertChange(tx, access, alert, { action: "reopen", toStatus: "open", note: text });
    return toSummary({ ...alert, status: "open" });
  });
}

export async function addAlertNote(access: OrgAccess, alertId: string, body: string): Promise<AlertNote> {
  access.assert("alerts.read");
  access.assert("notes.write");
  const parsed = z.string().trim().min(1, "A note cannot be empty.").max(10_000).safeParse(body ?? "");
  if (!parsed.success) throw new DomainError("invalid_note", parsed.error.issues[0]?.message ?? "Invalid note.", 422, { body: "Invalid note." });
  return access.tx(async (tx) => {
    const alert = await findAlert(tx, access, alertId);
    const [row] = await tx<{ id: string; created_at: Date }[]>`
      insert into notes (org_id, target_type, target_id, author_id, body)
      values (${access.org.id}, 'alert', ${alert.id}, ${actorUserId(access)}, ${parsed.data})
      returning id, created_at`;
    const n = row!;
    await recordAlertChange(tx, access, alert, { action: "note_add", toStatus: alert.status, metadata: { note_id: n.id } });
    return { id: n.id, body: parsed.data, authorId: actorUserId(access), authorName: access.principal.label, createdAt: n.created_at };
  });
}
