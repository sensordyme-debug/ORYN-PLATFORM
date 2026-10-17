/**
 * Data retention.
 *
 * Applies an organization's retention policy (organizations.settings
 * .retention) and audits what was removed:
 *
 *   auditDays    (default 365, never below 90)  audit events, via purge_audit_events()
 *   newsDays     (default 180)                  AOI news matches
 *   exportsDays  (default 7)                    ready exports past expiry → 'expired', file deleted
 *   jobsDays     (default 30)                   succeeded / cancelled jobs
 *   read in-app notifications older than 90 days
 *
 * Guarantees
 *  - Only the given org's rows are touched (tenant context + org filter).
 *  - The 90-day audit minimum is enforced here AND by the database function.
 *  - An export is marked expired only after its stored file was deleted, so
 *    a failed storage delete is retried on the next run.
 *  - JOB.retentionPurge as a platform job (org_id null) fans out one job per
 *    organization per day.
 */
import { z } from "zod";
import { recordAudit } from "@/server/audit";
import type { OrgSettings } from "@/server/authz/access";
import { uuidSchema } from "@/server/config/env";
import { withSystem, withTenant } from "@/server/db/client";
import { enqueueTx } from "@/server/jobs/queue";
import { JOB } from "@/server/jobs/types";
import type { JobHandler } from "@/server/jobs/worker";
import { log } from "@/server/log";
import { storage } from "@/server/storage";
import { parsePayload } from "@/server/alerts/job-payload";

export const RETENTION_DEFAULTS = { auditDays: 365, newsDays: 180, exportsDays: 7, jobsDays: 30, notificationsReadDays: 90 } as const;
export const AUDIT_MINIMUM_DAYS = 90;

export type RetentionPolicy = { auditDays: number; newsDays: number; exportsDays: number; jobsDays: number; notificationsReadDays: number };

export type RetentionResult = {
  orgId: string;
  policy: RetentionPolicy;
  auditEvents: number;
  newsMatches: number;
  exportsExpired: number;
  exportFilesDeleted: number;
  exportDeleteFailures: number;
  jobs: number;
  notifications: number;
};

const days = (v: unknown, fallback: number, min: number) => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.min(Math.max(n, min), 36_500);
};

/** Effective policy from org settings (invalid values fall back to defaults; audit never below 90 days). */
export function retentionPolicy(settings: OrgSettings | null | undefined): RetentionPolicy {
  const r = settings?.retention ?? {};
  return {
    auditDays: days(r.auditDays, RETENTION_DEFAULTS.auditDays, AUDIT_MINIMUM_DAYS),
    newsDays: days(r.newsDays, RETENTION_DEFAULTS.newsDays, 1),
    exportsDays: days(r.exportsDays, RETENTION_DEFAULTS.exportsDays, 1),
    jobsDays: days(r.jobsDays, RETENTION_DEFAULTS.jobsDays, 1),
    notificationsReadDays: RETENTION_DEFAULTS.notificationsReadDays,
  };
}

export async function applyRetention(orgId: string): Promise<RetentionResult> {
  const [org] = await withTenant({ orgId }, (tx) => tx<{ settings: OrgSettings }[]>`select settings from organizations where id = ${orgId}`);
  if (!org) throw new Error(`Organization ${orgId} not found.`);
  const policy = retentionPolicy(org.settings);
  const result: RetentionResult = {
    orgId,
    policy,
    auditEvents: 0,
    newsMatches: 0,
    exportsExpired: 0,
    exportFilesDeleted: 0,
    exportDeleteFailures: 0,
    jobs: 0,
    notifications: 0,
  };

  // Exports: delete stored files first, then mark expired (one row at a time).
  const due = await withTenant({ orgId }, (tx) =>
    tx<{ id: string; storage_key: string | null }[]>`
      select id, storage_key from exports
       where org_id = ${orgId} and status = 'ready' and expires_at is not null and expires_at <= now()
       order by expires_at limit 1000`,
  );
  for (const e of due) {
    if (e.storage_key) {
      try {
        await storage().delete(e.storage_key);
        result.exportFilesDeleted++;
      } catch (err) {
        result.exportDeleteFailures++;
        log.warn("retention.export_delete_failed", { orgId, exportId: e.id, err });
        continue;
      }
    }
    const rows = await withTenant({ orgId }, (tx) =>
      tx`update exports set status = 'expired', storage_key = null where id = ${e.id} and org_id = ${orgId} and status = 'ready' returning id`,
    );
    result.exportsExpired += rows.length;
  }

  await withTenant({ orgId }, async (tx) => {
    const [audit] = await tx<{ n: number }[]>`
      select purge_audit_events(${orgId}, now() - make_interval(days => ${policy.auditDays})) as n`;
    result.auditEvents = audit?.n ?? 0;
    result.newsMatches = (
      await tx`delete from aoi_news_matches where org_id = ${orgId} and created_at < now() - make_interval(days => ${policy.newsDays}) returning aoi_id`
    ).length;
    result.jobs = (
      await tx`
        delete from jobs
         where org_id = ${orgId} and status in ('succeeded', 'cancelled')
           and coalesce(finished_at, updated_at) < now() - make_interval(days => ${policy.jobsDays})
        returning id`
    ).length;
    result.notifications = (
      await tx`
        delete from notifications
         where org_id = ${orgId} and read_at is not null and read_at < now() - make_interval(days => ${policy.notificationsReadDays})
        returning id`
    ).length;
    await recordAudit(tx, {
      orgId,
      actor: { type: "system", label: "retention.purge" },
      action: "retention.purge",
      targetType: "organization",
      targetId: orgId,
      metadata: {
        policy,
        purged: {
          audit_events: result.auditEvents,
          news_matches: result.newsMatches,
          exports_expired: result.exportsExpired,
          export_files_deleted: result.exportFilesDeleted,
          export_delete_failures: result.exportDeleteFailures,
          jobs: result.jobs,
          notifications: result.notifications,
        },
      },
    });
  });
  return result;
}

export const retentionPurgePayload = z.object({ orgId: uuidSchema.optional() });

export const retentionPurgeHandler: JobHandler = {
  type: JOB.retentionPurge,
  describe: "Apply data retention policy",
  async run(ctx) {
    const p = parsePayload(retentionPurgePayload, ctx);
    const orgId = ctx.job.org_id ?? p.orgId ?? null;
    if (orgId) return applyRetention(orgId);
    // Platform sweep: one job per organization per day.
    const day = new Date().toISOString().slice(0, 10);
    const enqueued = await withSystem("retention.fan_out", async (tx) => {
      const orgs = await tx<{ id: string }[]>`select id from organizations where archived_at is null order by id`;
      let n = 0;
      for (const o of orgs) {
        const r = await enqueueTx(tx, { orgId: o.id, type: JOB.retentionPurge, idempotencyKey: `retention.purge:${o.id}:${day}`, parentJobId: ctx.job.id, priority: 200 });
        if (r.created) n++;
      }
      return n;
    });
    return { fanOut: enqueued };
  },
};
