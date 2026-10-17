/**
 * Job handlers for alerting. Registered by the job registry under the JOB
 * names below; payloads are validated and malformed payloads fail
 * permanently (retrying cannot fix them).
 *
 *   JOB.alertsEvaluate  org job   { aoiId, trigger: { kind, ids? }, reprocessing? }
 *   JOB.alertsDeliver   org job   { alertId, reason: 'created' | 'escalated' }
 *   JOB.alertsEscalate  org job   {}  (or a platform job — org_id null — sweeping every org)
 */
import { z } from "zod";
import { uuidSchema } from "@/server/config/env";
import { JOB } from "@/server/jobs/types";
import type { JobHandler } from "@/server/jobs/worker";
import { parsePayload, requireOrg } from "@/server/alerts/job-payload";
import { escalateAlerts } from "@/server/alerts/escalate";
import { evaluateAlertsForAoi } from "@/server/alerts/pipeline";
import { deliverAlertNotifications } from "@/server/notifications/deliver";

export const alertsEvaluatePayload = z.object({
  aoiId: uuidSchema,
  trigger: z.object({
    kind: z.enum(["observation", "detection", "weather", "warning", "schedule"]),
    ids: z.array(z.string().min(1).max(64)).max(1000).optional(),
  }),
  reprocessing: z.boolean().optional(),
  historical: z.boolean().optional(),
});
export type AlertsEvaluatePayload = z.infer<typeof alertsEvaluatePayload>;

export const alertsDeliverPayload = z.object({ alertId: uuidSchema, reason: z.enum(["created", "escalated"]).default("created") });
export type AlertsDeliverPayload = z.input<typeof alertsDeliverPayload>;

export const alertsEscalatePayload = z.object({ orgId: uuidSchema.optional() });

export const alertsEvaluateHandler: JobHandler = {
  type: JOB.alertsEvaluate,
  describe: "Evaluate alert rules for an area",
  async run(ctx) {
    const orgId = requireOrg(ctx);
    const p = parsePayload(alertsEvaluatePayload, ctx);
    const r = await evaluateAlertsForAoi({ orgId, aoiId: p.aoiId, trigger: p.trigger, reprocessing: p.reprocessing, historical: p.historical });
    ctx.log.info("alerts.evaluated", { aoiId: p.aoiId, created: r.created, suppressed: r.suppressed, skipped: r.skipped });
    // Delivery jobs for notifiable alerts were enqueued in the same transaction as the alerts.
    return {
      created: r.created,
      suppressed: r.suppressed,
      skipped: r.skipped,
      alerts: r.alerts.map((a) => ({ id: a.id, status: a.status, from_reprocessing: a.fromReprocessing, notify: a.notify })),
      notes: r.notes.slice(0, 100),
    };
  },
};

export const alertsDeliverHandler: JobHandler = {
  type: JOB.alertsDeliver,
  describe: "Deliver alert notifications",
  async run(ctx) {
    const orgId = requireOrg(ctx);
    const p = parsePayload(alertsDeliverPayload, ctx);
    return deliverAlertNotifications({ orgId, alertId: p.alertId, reason: p.reason });
  },
};

export const alertsEscalateHandler: JobHandler = {
  type: JOB.alertsEscalate,
  describe: "Escalate unacknowledged alerts",
  async run(ctx) {
    const p = parsePayload(alertsEscalatePayload, ctx);
    return escalateAlerts({ orgId: ctx.job.org_id ?? p.orgId ?? null });
  },
};

export const ALERT_HANDLERS: JobHandler[] = [alertsEvaluateHandler, alertsDeliverHandler, alertsEscalateHandler];
