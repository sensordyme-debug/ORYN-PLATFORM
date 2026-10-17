/**
 * Escalation of unacknowledged alerts.
 *
 * An open alert whose rule sets escalate_after_hours, still at escalation
 * level 0 after that many hours, moves to level 1: escalated_at is set, an
 * alert_events 'escalated' row and an audit row are written, and a delivery
 * job notifies the rule's escalate_to_roles — all in one transaction.
 *
 * Guarantees
 *  - Each alert escalates at most once (the level check is part of the
 *    UPDATE, so concurrent sweeps cannot double-escalate).
 *  - Suppressed alerts and alerts from reprocessing are never escalated
 *    (they were never notified in the first place).
 */
import { recordAudit } from "@/server/audit";
import { withSystem, withTenant } from "@/server/db/client";
import { enqueueTx } from "@/server/jobs/queue";
import { JOB } from "@/server/jobs/types";

export type EscalationResult = { orgs: number; escalated: number; alertIds: string[] };

/** Escalate one org's overdue alerts, or (without orgId) sweep every org. */
export async function escalateAlerts(opts: { orgId?: string | null } = {}): Promise<EscalationResult> {
  const orgIds = opts.orgId
    ? [opts.orgId]
    : (
        await withSystem("alerts.escalate_sweep", (tx) =>
          tx<{ org_id: string }[]>`
            select distinct a.org_id
              from alerts a join alert_rules r on r.id = a.rule_id
             where a.status = 'open' and a.escalation_level = 0 and not a.from_reprocessing
               and r.escalate_after_hours is not null
               and a.created_at < now() - make_interval(hours => r.escalate_after_hours)`,
        )
      ).map((r) => r.org_id);

  const result: EscalationResult = { orgs: orgIds.length, escalated: 0, alertIds: [] };
  for (const orgId of orgIds) {
    const ids = await withTenant({ orgId }, async (tx) => {
      const rows = await tx<{ id: string; hours: number; roles: string[] }[]>`
        update alerts a set escalation_level = 1, escalated_at = now()
          from alert_rules r
         where r.id = a.rule_id and a.org_id = ${orgId} and r.org_id = ${orgId}
           and a.status = 'open' and a.escalation_level = 0 and not a.from_reprocessing
           and r.escalate_after_hours is not null
           and a.created_at < now() - make_interval(hours => r.escalate_after_hours)
        returning a.id, r.escalate_after_hours as hours, r.escalate_to_roles::text[] as roles`;
      for (const a of rows) {
        await tx`
          insert into alert_events (org_id, alert_id, action, from_status, to_status, note)
          values (${orgId}, ${a.id}, 'escalated', 'open', 'open',
                  ${`Not acknowledged within ${a.hours} h; escalated to ${a.roles.join(", ")}.`})`;
        await recordAudit(tx, {
          orgId,
          actor: { type: "system", label: "alerts.escalate" },
          action: "alert.escalate",
          targetType: "alert",
          targetId: a.id,
          metadata: { escalation_level: 1, after_hours: a.hours, roles: a.roles },
        });
        await enqueueTx(tx, {
          orgId,
          type: JOB.alertsDeliver,
          payload: { alertId: a.id, reason: "escalated" },
          idempotencyKey: `alerts.deliver:${a.id}:escalated:1`,
          priority: 40,
        });
      }
      return rows.map((r) => r.id);
    });
    result.escalated += ids.length;
    result.alertIds.push(...ids);
  }
  return result;
}
