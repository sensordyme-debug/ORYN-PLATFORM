import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/authz/access";
import { DomainError } from "@/server/errors";
import { claimJobs, enqueue } from "@/server/jobs/queue";
import { JOB } from "@/server/jobs/types";
import { executeJob } from "@/server/jobs/worker";
import { escalateAlerts } from "@/server/alerts/escalate";
import { ALERT_HANDLERS } from "@/server/alerts/handlers";
import { evaluateAlertsForAoi } from "@/server/alerts/pipeline";
import { createAlertRule, deleteAlertRule, disableAlertRule, updateAlertRule } from "@/server/alerts/rule-service";
import { acknowledgeAlert, addAlertNote, assignAlert, getAlert, listAlerts, reopenAlert, resolveAlert } from "@/server/alerts/service";
import { deliverAlertNotifications } from "@/server/notifications/deliver";
import { alertUrl, type EmailMessage } from "@/server/notifications/email";
import { listNotifications, markRead } from "@/server/notifications/service";
import { closeTestDb, createOrg, insertAoi, ownerSql, resetDb, SQUARE } from "../helpers/db";
import { daysAgo, dbDaysAgo, grantAoi, insertDetection, insertObservation, insertRule, insertWarning, member, rows } from "./alerts.fixtures";

const obsTrigger = { kind: "observation" as const };

async function setup() {
  const org = await createOrg("org-a");
  const aoi = await insertAoi(org.id, "North Field");
  const admin = await member(org, "org_admin");
  return { org, aoi, admin };
}

async function alertRows(orgId: string) {
  return rows<{ id: string; status: string; from_reprocessing: boolean; title: string; dedupe_key: string; explanation: Record<string, unknown>; observed_at: Date; processed_at: Date; ingested_at: Date; notified_at: Date | null }>`
    select * from alerts where org_id = ${orgId} order by created_at, id`;
}

async function deliverJobs() {
  return rows<{ payload: { alertId: string; reason: string } }>`select payload from jobs where type = ${JOB.alertsDeliver} order by created_at`;
}

describe("alert evaluation", () => {
  beforeEach(async () => {
    await resetDb();
    delete process.env.RESEND_API_KEY;
    delete process.env.ORYN_EMAIL_FROM;
  });
  afterAll(closeTestDb);

  it("evaluating the same evidence twice creates one alert, with event, audit, and one delivery job", async () => {
    const { org, aoi } = await setup();
    const ruleId = await insertRule(org.id, "ndvi_below", { threshold: 0.4 });
    const o = await insertObservation(org.id, aoi, { observedAt: daysAgo(2), mean: 0.31 });

    const first = await evaluateAlertsForAoi({ orgId: org.id, aoiId: aoi, trigger: obsTrigger });
    const second = await evaluateAlertsForAoi({ orgId: org.id, aoiId: aoi, trigger: obsTrigger });
    expect(first).toMatchObject({ created: 1, suppressed: 0, skipped: 0 });
    expect(second).toMatchObject({ created: 0, suppressed: 0, skipped: 1 });

    const alerts = await alertRows(org.id);
    expect(alerts).toHaveLength(1);
    const a = alerts[0]!;
    expect(a.dedupe_key).toBe(`ndvi_below:${ruleId}:${o.id}`);
    expect(a.status).toBe("open");
    expect(a.from_reprocessing).toBe(false);
    expect(a.observed_at.getTime()).toBeLessThan(a.ingested_at.getTime());
    expect(a.ingested_at.getTime()).toBeLessThan(a.processed_at.getTime());
    expect(a.explanation).toMatchObject({ basis: "deterministic_calculation", rule: { id: ruleId } });
    expect((a.explanation.evidence as { id: string }[]).map((e) => e.id)).toContain(o.id);
    expect(await rows`select action, to_status from alert_events where alert_id = ${a.id}`).toEqual([{ action: "created", to_status: "open" }]);
    expect(await rows`select actor_type, action from audit_events where target_id = ${a.id}`).toEqual([{ actor_type: "system", action: "alert.create" }]);
    expect(await deliverJobs()).toEqual([{ payload: { alertId: a.id, reason: "created" } }]);
  });

  it("produces no alert and an insufficient-data note when the baseline is too small", async () => {
    const { org, aoi } = await setup();
    await insertRule(org.id, "ndvi_drop_vs_baseline", {});
    await insertObservation(org.id, aoi, { observedAt: daysAgo(2), mean: 0.2 });
    await insertObservation(org.id, aoi, { observedAt: daysAgo(12), mean: 0.8 });
    const r = await evaluateAlertsForAoi({ orgId: org.id, aoiId: aoi, trigger: obsTrigger });
    expect(r.created).toBe(0);
    expect(r.notes).toEqual([expect.objectContaining({ code: "insufficient_data" })]);
    expect(await alertRows(org.id)).toHaveLength(0);
  });

  it("suppresses a second alert inside the cooldown and never notifies it", async () => {
    const { org, aoi } = await setup();
    await member(org, "analyst");
    await insertRule(org.id, "ndvi_below", { threshold: 0.4 }, { cooldownHours: 24 });
    await insertObservation(org.id, aoi, { observedAt: daysAgo(6), mean: 0.3 });
    await evaluateAlertsForAoi({ orgId: org.id, aoiId: aoi, trigger: obsTrigger });
    await insertObservation(org.id, aoi, { observedAt: daysAgo(1), mean: 0.25 });
    const r = await evaluateAlertsForAoi({ orgId: org.id, aoiId: aoi, trigger: obsTrigger });
    expect(r).toMatchObject({ created: 0, suppressed: 1 });

    const [first, second] = await alertRows(org.id);
    expect(second!.status).toBe("suppressed");
    expect(second!.explanation.suppressed_reason).toMatch(/24-hour cooldown/);
    expect(await deliverJobs()).toHaveLength(1);
    expect(await deliverAlertNotifications({ orgId: org.id, alertId: second!.id, reason: "created" })).toMatchObject({ status: "skipped", reason: "suppressed" });
    expect(await rows`select id from notifications where alert_id = ${second!.id}`).toHaveLength(0);
    const delivered = await deliverAlertNotifications({ orgId: org.id, alertId: first!.id, reason: "created" });
    expect(delivered.inApp).toBe(2);
  });

  it("marks alerts from reprocessing (payload flag) and never notifies them", async () => {
    const { org, aoi } = await setup();
    await insertRule(org.id, "ndvi_below", { threshold: 0.4 });
    await insertObservation(org.id, aoi, { observedAt: daysAgo(40), mean: 0.3 });
    const r = await evaluateAlertsForAoi({ orgId: org.id, aoiId: aoi, trigger: obsTrigger, reprocessing: true });
    expect(r.alerts).toEqual([expect.objectContaining({ fromReprocessing: true, notify: false, status: "open" })]);
    const [a] = await alertRows(org.id);
    expect(a!.from_reprocessing).toBe(true);
    expect(a!.title).toMatch(/^Reprocessed data: /);
    expect(a!.explanation.reprocessing).toMatch(/not a new observation/);
    expect(await deliverJobs()).toHaveLength(0);
    expect(await deliverAlertNotifications({ orgId: org.id, alertId: a!.id, reason: "created" })).toMatchObject({ status: "skipped", reason: "from_reprocessing" });
  });

  it("recognises re-derived results for an acquisition time already alerted on", async () => {
    const { org, aoi } = await setup();
    await insertRule(org.id, "ndvi_below", { threshold: 0.4 }, { cooldownHours: 0 });
    const t = daysAgo(3);
    const v1 = await insertObservation(org.id, aoi, { observedAt: t, mean: 0.3 });
    await evaluateAlertsForAoi({ orgId: org.id, aoiId: aoi, trigger: obsTrigger });
    // A re-run supersedes the old observation with a new row for the same acquisition.
    await ownerSql()`update observations set is_current = false where id = ${v1.id}`;
    await insertObservation(org.id, aoi, { observedAt: t, mean: 0.29 });
    const r = await evaluateAlertsForAoi({ orgId: org.id, aoiId: aoi, trigger: obsTrigger });
    expect(r.alerts).toEqual([expect.objectContaining({ fromReprocessing: true, notify: false })]);
    expect(await deliverJobs()).toHaveLength(1);
  });

  it("creates one alert per matching detection and per active official warning", async () => {
    const { org, aoi } = await setup();
    const detRule = await insertRule(org.id, "detection_created", { min_evidence_grade: "moderate" }, { cooldownHours: 0 });
    const d1 = await insertDetection(org.id, aoi, { grade: "strong" });
    await insertDetection(org.id, aoi, { grade: "weak" });
    const r = await evaluateAlertsForAoi({ orgId: org.id, aoiId: aoi, trigger: { kind: "detection", ids: [d1] } });
    expect(r.created).toBe(1);
    const [a] = await rows<{ dedupe_key: string; detection_id: string; geom_type: string }>`
      select dedupe_key, detection_id, ST_GeometryType(geom) as geom_type from alerts where org_id = ${org.id}`;
    expect(a).toEqual({ dedupe_key: `detection:${detRule}:${d1}`, detection_id: d1, geom_type: "ST_Polygon" });

    await insertRule(org.id, "nws_warning", { min_severity: "Severe" });
    const w = await insertWarning(org.id, aoi, { severity: "Extreme" });
    await insertWarning(org.id, aoi, { severity: "Minor" });
    const wr = await evaluateAlertsForAoi({ orgId: org.id, aoiId: aoi, trigger: { kind: "warning" } });
    expect(wr.created).toBe(1);
    const [warn] = await rows<{ event_at: Date | null; explanation: { basis: string } }>`select event_at, explanation from alerts where dedupe_key like ${`warning:%:${w}`}`;
    expect(warn!.event_at).not.toBeNull();
    expect(warn!.explanation.basis).toBe("official_warning");
  });

  it("runs through the JOB.alertsEvaluate handler and rejects malformed payloads permanently", async () => {
    const { org, aoi } = await setup();
    await insertRule(org.id, "stale_observations", { max_age_days: 7 });
    // The title floors (database now − observed) to whole days: take both from the database clock.
    await insertObservation(org.id, aoi, { observedAt: await dbDaysAgo(30), mean: 0.5 });
    await ownerSql()`update aois set created_at = now() - interval '60 days' where id = ${aoi}`;
    const registry = new Map(ALERT_HANDLERS.map((h) => [h.type, h]));
    const ok = await enqueue({ orgId: org.id, type: JOB.alertsEvaluate, payload: { aoiId: aoi, trigger: { kind: "schedule" } } });
    const bad = await enqueue({ orgId: org.id, type: JOB.alertsEvaluate, payload: { aoiId: "nope" } });
    for (const j of await claimJobs("w1", 5, [JOB.alertsEvaluate])) await executeJob(j, registry, "w1");
    const [okJob] = await rows<{ status: string; result: { created: number } }>`select status, result from jobs where id = ${ok.id}`;
    expect(okJob).toMatchObject({ status: "succeeded", result: { created: 1 } });
    const [badJob] = await rows<{ status: string }>`select status from jobs where id = ${bad.id}`;
    expect(badJob!.status).toBe("failed");
    const [alert] = await alertRows(org.id);
    expect(alert!.title).toMatch(/^Data gap: no usable imagery for 30 days/);
  });
});

describe("notifications", () => {
  beforeEach(async () => {
    await resetDb();
    delete process.env.RESEND_API_KEY;
    delete process.env.ORYN_EMAIL_FROM;
  });
  afterAll(closeTestDb);

  it("notifies only roles in notify_roles who can see the AOI; restricted members need a grant", async () => {
    const { org, aoi, admin } = await setup();
    const otherAoi = await insertAoi(org.id, "South Field", SQUARE(-77.5, 35.8));
    const analyst = await member(org, "analyst");
    const viewer = await member(org, "viewer");
    const restrictedNoGrant = await member(org, "analyst", true);
    const restrictedGranted = await member(org, "analyst", true);
    await grantAoi(org.id, restrictedGranted.membershipId, aoi);
    await grantAoi(org.id, restrictedNoGrant.membershipId, otherAoi);
    await insertRule(org.id, "ndvi_below", { threshold: 0.4 }, { notifyEmail: true });
    await insertObservation(org.id, aoi, { observedAt: daysAgo(2), mean: 0.2 });
    const { alerts } = await evaluateAlertsForAoi({ orgId: org.id, aoiId: aoi, trigger: obsTrigger });
    const alertId = alerts[0]!.id;

    const r = await deliverAlertNotifications({ orgId: org.id, alertId, reason: "created" });
    expect(r).toMatchObject({ inApp: 3, emailSent: 0, emailSkipped: 3 });
    const inApp = await rows<{ user_id: string }>`select user_id from notifications where alert_id = ${alertId} and channel = 'in_app' order by user_id`;
    expect(inApp.map((n) => n.user_id).sort()).toEqual([admin.id, analyst.id, restrictedGranted.id].sort());
    const email = await rows<{ status: string; status_reason: string }>`select status, status_reason from notifications where alert_id = ${alertId} and channel = 'email'`;
    expect(email).toHaveLength(3);
    expect(email.every((e) => e.status === "skipped" && e.status_reason === "email_not_configured")).toBe(true);
    const [a] = await alertRows(org.id);
    expect(a!.notified_at).not.toBeNull();

    expect(await listNotifications(viewer.id, org.id)).toEqual([]);
    expect(await listNotifications(restrictedNoGrant.id, org.id)).toEqual([]);
    const list = await listNotifications(analyst.id, org.id, true);
    expect(list).toEqual([expect.objectContaining({ alertId, aoiName: "North Field", readAt: null })]);
    expect(await markRead(analyst.id, org.id, [list[0]!.id])).toBe(1);
    expect(await listNotifications(analyst.id, org.id, true)).toEqual([]);
    expect(await markRead(viewer.id, org.id)).toBe(0);

    // Idempotent: a second delivery creates nothing new.
    expect(await deliverAlertNotifications({ orgId: org.id, alertId, reason: "created" })).toMatchObject({ inApp: 0 });
    expect(await rows`select id from notifications where alert_id = ${alertId}`).toHaveLength(6);
  });

  it("sends email through the configured transport with what / where / when / why and the evidence link, exactly once", async () => {
    const { org, aoi, admin } = await setup();
    await insertRule(org.id, "ndvi_below", { threshold: 0.4 }, { notifyEmail: true, notifyRoles: ["org_admin"] });
    await insertObservation(org.id, aoi, { observedAt: daysAgo(2), mean: 0.2 });
    const { alerts } = await evaluateAlertsForAoi({ orgId: org.id, aoiId: aoi, trigger: obsTrigger });
    const alertId = alerts[0]!.id;
    const sent: EmailMessage[] = [];
    const sendEmail = vi.fn(async (m: EmailMessage) => (sent.push(m), { ok: true as const, providerId: "re_1" }));
    const deps = { emailConfig: { apiKey: "re_test", from: "ORYN <alerts@example.test>" }, sendEmail };
    expect(await deliverAlertNotifications({ orgId: org.id, alertId, reason: "created" }, deps)).toMatchObject({ emailSent: 1 });
    await deliverAlertNotifications({ orgId: org.id, alertId, reason: "created" }, deps);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const m = sent[0]!;
    expect(m.to).toBe(admin.email);
    expect(m.subject).toMatch(/^\[ORYN\] HIGH: NDVI 0\.2 below 0\.4 at North Field/);
    for (const part of ["WHAT", "WHERE", "WHEN", "Data acquired:", "Processed by ORYN:", "WHY", "EVIDENCE", "LIMITATIONS", "North Field"]) expect(m.text).toContain(part);
    expect(m.text).toContain(alertUrl("org-a", alertId));
    expect(alertUrl("org-a", alertId)).toMatch(new RegExp(`^https?://[^/]+(/.*)?/app/org-a/alerts/${alertId}$`));
    expect(await rows`select status from notifications where alert_id = ${alertId} and channel = 'email'`).toEqual([{ status: "sent" }]);
  });

  it("escalates unacknowledged alerts once and notifies the escalation roles", async () => {
    const { org, aoi, admin } = await setup();
    const analyst = await member(org, "analyst");
    await insertRule(org.id, "ndvi_below", { threshold: 0.4 }, { escalateAfterHours: 2, notifyRoles: ["analyst"], escalateToRoles: ["org_admin"] });
    await insertObservation(org.id, aoi, { observedAt: daysAgo(2), mean: 0.2 });
    const { alerts } = await evaluateAlertsForAoi({ orgId: org.id, aoiId: aoi, trigger: obsTrigger });
    const alertId = alerts[0]!.id;
    await deliverAlertNotifications({ orgId: org.id, alertId, reason: "created" });
    expect(await escalateAlerts()).toMatchObject({ escalated: 0 });
    await ownerSql()`update alerts set created_at = now() - interval '3 hours' where id = ${alertId}`;
    expect(await escalateAlerts()).toMatchObject({ escalated: 1, alertIds: [alertId] });
    expect(await escalateAlerts({ orgId: org.id })).toMatchObject({ escalated: 0 });
    const [a] = await rows<{ escalation_level: number; escalated_at: Date | null }>`select escalation_level, escalated_at from alerts where id = ${alertId}`;
    expect(a!.escalation_level).toBe(1);
    expect(a!.escalated_at).not.toBeNull();
    expect(await rows`select action from alert_events where alert_id = ${alertId} order by id`).toEqual([{ action: "created" }, { action: "escalated" }]);
    expect((await deliverJobs()).map((j) => j.payload.reason)).toEqual(["created", "escalated"]);
    await deliverAlertNotifications({ orgId: org.id, alertId, reason: "escalated" });
    const notified = await rows<{ user_id: string; status_reason: string | null }>`select user_id, status_reason from notifications where alert_id = ${alertId} order by user_id`;
    expect(notified).toEqual(expect.arrayContaining([{ user_id: admin.id, status_reason: "escalated" }, { user_id: analyst.id, status_reason: null }]));
  });
});

describe("alert lifecycle and rules", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  async function withAlert() {
    const s = await setup();
    await insertRule(s.org.id, "ndvi_below", { threshold: 0.4 });
    await insertObservation(s.org.id, s.aoi, { observedAt: daysAgo(2), mean: 0.2 });
    const { alerts } = await evaluateAlertsForAoi({ orgId: s.org.id, aoiId: s.aoi, trigger: obsTrigger });
    return { ...s, alertId: alerts[0]!.id };
  }

  it("each transition writes alert_events and audit rows", async () => {
    const { org, alertId, admin } = await withAlert();
    const op = await member(org, "field_operator");
    const viewer = await member(org, "viewer");
    await expect(acknowledgeAlert(viewer.access, alertId)).rejects.toBeInstanceOf(AccessError);

    expect(await acknowledgeAlert(op.access, alertId, "Looking into it")).toMatchObject({ status: "acknowledged" });
    await expect(acknowledgeAlert(op.access, alertId)).rejects.toMatchObject({ code: "invalid_transition" });
    await assignAlert(admin.access, alertId, op.id);
    await expect(assignAlert(admin.access, alertId, "no-such-user")).rejects.toMatchObject({ code: "invalid_assignee" });
    await expect(resolveAlert(op.access, alertId, "  ")).rejects.toMatchObject({ code: "note_required" });
    await resolveAlert(op.access, alertId, "Harvested on schedule.");
    await reopenAlert(admin.access, alertId, "Second look");
    await addAlertNote(op.access, alertId, "Field visit booked.");

    expect(await rows`select action, from_status, to_status from alert_events where alert_id = ${alertId} order by id`).toEqual([
      { action: "created", from_status: null, to_status: "open" },
      { action: "acknowledged", from_status: "open", to_status: "acknowledged" },
      { action: "assigned", from_status: "acknowledged", to_status: "acknowledged" },
      { action: "resolved", from_status: "acknowledged", to_status: "resolved" },
      { action: "reopened", from_status: "resolved", to_status: "open" },
      { action: "note_added", from_status: "open", to_status: "open" },
    ]);
    expect((await rows<{ action: string }>`select action from audit_events where target_id = ${alertId} order by id`).map((r) => r.action)).toEqual([
      "alert.create",
      "alert.acknowledge",
      "alert.assign",
      "alert.resolve",
      "alert.reopen",
      "alert.note_add",
    ]);

    const detail = await getAlert(viewer.access, alertId);
    expect(detail.status).toBe("open");
    expect(detail.assignedTo).toBe(op.id);
    expect(detail.resolvedAt).toBeNull();
    expect(detail.events).toHaveLength(6);
    expect(detail.notes.map((n) => n.body)).toEqual(["Field visit booked."]);
    const obsEvidence = detail.evidence.find((e) => e.type === "observation")!;
    expect(obsEvidence.records[0]).toMatchObject({ kind: "ndvi", status: "valid" });
    expect(detail.evidence.find((e) => e.type === "source_asset")!.records[0]).toMatchObject({ collection: "sentinel-2-l2a" });
  });

  it("lists with filters and keyset pagination, hiding restricted AOIs", async () => {
    const { org, aoi, admin } = await setup();
    const other = await insertAoi(org.id, "South Field", SQUARE(-77.5, 35.8));
    await insertRule(org.id, "ndvi_below", { threshold: 0.4 }, { cooldownHours: 0 });
    for (const [a, d] of [[aoi, 3], [aoi, 2], [other, 1]] as const) {
      await insertObservation(org.id, a, { observedAt: daysAgo(d), mean: 0.1 });
      await evaluateAlertsForAoi({ orgId: org.id, aoiId: a, trigger: obsTrigger });
    }
    const p1 = await listAlerts(admin.access, { limit: 2 });
    expect(p1.items).toHaveLength(2);
    const p2 = await listAlerts(admin.access, { limit: 2, cursor: p1.nextCursor });
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((i) => i.id)).size).toBe(3);
    expect((await listAlerts(admin.access, { aoiId: other })).items).toHaveLength(1);
    expect((await listAlerts(admin.access, { status: ["resolved"] })).items).toHaveLength(0);

    const restricted = await member(org, "field_operator", true);
    await grantAoi(org.id, restricted.membershipId, other);
    const visible = await listAlerts(restricted.access);
    expect(visible.items.map((i) => i.aoiName)).toEqual(["South Field"]);
    const hidden = (await listAlerts(admin.access, { aoiId: aoi })).items[0]!.id;
    await expect(getAlert(restricted.access, hidden)).rejects.toMatchObject({ status: 404 });
  });

  it("a user from org B cannot get or acknowledge org A's alert (not found)", async () => {
    const { alertId } = await withAlert();
    const orgB = await createOrg("org-b");
    const bAdmin = await member(orgB, "org_admin");
    await expect(getAlert(bAdmin.access, alertId)).rejects.toBeInstanceOf(DomainError);
    await expect(getAlert(bAdmin.access, alertId)).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(acknowledgeAlert(bAdmin.access, alertId)).rejects.toMatchObject({ status: 404 });
    expect(await rows`select status from alerts where id = ${alertId}`).toEqual([{ status: "open" }]);
  });

  it("manages rules with catalog validation, org ownership, and audit", async () => {
    const { org, aoi, admin } = await setup();
    const viewer = await member(org, "viewer");
    const orgB = await createOrg("org-b");
    const aoiB = await insertAoi(orgB.id, "B field");
    await expect(createAlertRule(viewer.access, { name: "x", ruleType: "ndvi_below", params: { threshold: 0.3 }, severity: "low" })).rejects.toBeInstanceOf(AccessError);
    await expect(createAlertRule(admin.access, { name: "x", ruleType: "ndvi_below", params: {}, severity: "low" })).rejects.toMatchObject({ code: "invalid_rule_params" });
    await expect(createAlertRule(admin.access, { name: "x", ruleType: "made_up", severity: "low" })).rejects.toMatchObject({ code: "invalid_rule_type" });
    await expect(createAlertRule(admin.access, { name: "x", ruleType: "ndvi_below", params: { threshold: 0.3 }, severity: "low", aoiId: aoiB })).rejects.toMatchObject({ code: "invalid_aoi" });

    const rule = await createAlertRule(admin.access, { name: "Drop", ruleType: "ndvi_drop_vs_baseline", severity: "moderate", aoiId: aoi, notifyRoles: ["org_admin", "field_operator"] });
    expect(rule.params).toEqual({ min_drop: 0.1, min_baseline_n: 3, baseline_days: 90 });
    expect(rule.notifyRoles).toEqual(["org_admin", "field_operator"]);
    const updated = await updateAlertRule(admin.access, rule.id, { params: { min_drop: 0.2 }, cooldownHours: 48 });
    expect(updated).toMatchObject({ params: { min_drop: 0.2, min_baseline_n: 3 }, cooldownHours: 48 });
    expect((await disableAlertRule(admin.access, rule.id)).enabled).toBe(false);
    await deleteAlertRule(admin.access, rule.id);
    expect((await rows<{ action: string }>`select action from audit_events where target_id = ${rule.id} order by id`).map((r) => r.action)).toEqual([
      "alert_rule.create",
      "alert_rule.update",
      "alert_rule.disable",
      "alert_rule.delete",
    ]);
  });
});
