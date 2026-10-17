/**
 * Alert notification delivery (in-app and email).
 *
 * Guarantees
 *  - Recipients are members whose role is in the rule's notify_roles
 *    (escalate_to_roles for escalations) AND who can see the alert's AOI
 *    (aoi_restricted members need an aoi_grants row).
 *  - Suppressed alerts and alerts from reprocessing are never notified.
 *  - Idempotent: one notification row per (alert, user, channel); a retried
 *    job never sends a channel that already succeeded.
 *  - Email is attempted only when the rule enables it AND Resend is
 *    configured; otherwise the row is recorded as 'skipped' with
 *    status_reason 'email_not_configured'.
 *  - No database transaction is held open during network calls.
 *  - alerts.notified_at is set once no delivery is pending and at least one
 *    recipient was notified. Retryable send failures leave rows pending and
 *    throw so the job is retried.
 */
import { isPlaceholderEmail } from "@/lib/accounts";
import { withTenant, type Tx } from "@/server/db/client";
import { log } from "@/server/log";
import type { AlertExplanation } from "@/server/alerts/explain";
import { emailConfig, emailUnavailableReason, renderAlertEmail, resendSender, type EmailConfig, type EmailSender } from "@/server/notifications/email";

export type DeliveryReason = "created" | "escalated";

export type DeliveryResult = {
  status: "delivered" | "skipped";
  reason?: string;
  inApp: number;
  emailSent: number;
  emailSkipped: number;
  emailFailed: number;
};

export type DeliveryDeps = {
  /** Override the email transport (tests). */
  sendEmail?: EmailSender;
  /** Override email configuration; null forces "not configured". */
  emailConfig?: EmailConfig | null;
};

type AlertForDelivery = {
  id: string;
  aoi_id: string;
  status: string;
  title: string;
  severity: string;
  explanation: AlertExplanation;
  from_reprocessing: boolean;
  event_at: Date | null;
  observed_at: Date | null;
  ingested_at: Date | null;
  processed_at: Date | null;
  created_at: Date;
  rule_name: string | null;
  notify_in_app: boolean | null;
  notify_email: boolean | null;
  notify_roles: string[] | null;
  escalate_to_roles: string[] | null;
  escalate_after_hours: number | null;
  org_slug: string;
  org_name: string;
};

const DEFAULT_NOTIFY_ROLES = ["org_admin", "analyst"];
const DEFAULT_ESCALATE_ROLES = ["org_admin"];

export async function deliverAlertNotifications(
  input: { orgId: string; alertId: string; reason: DeliveryReason },
  deps: DeliveryDeps = {},
): Promise<DeliveryResult> {
  const config = deps.emailConfig !== undefined ? deps.emailConfig : emailConfig();
  const unavailable = deps.emailConfig !== undefined ? "email_not_configured" : emailUnavailableReason();
  const result: DeliveryResult = { status: "delivered", inApp: 0, emailSent: 0, emailSkipped: 0, emailFailed: 0 };

  // 1. Decide recipients and record channel rows.
  const plan = await withTenant({ orgId: input.orgId }, async (tx) => {
    const [alert] = await tx<AlertForDelivery[]>`
      select a.id, a.aoi_id, a.status, a.title, a.severity, a.explanation, a.from_reprocessing,
             a.event_at, a.observed_at, a.ingested_at, a.processed_at, a.created_at,
             r.name as rule_name, r.notify_in_app, r.notify_email, r.notify_roles::text[] as notify_roles,
             r.escalate_to_roles::text[] as escalate_to_roles, r.escalate_after_hours,
             o.slug::text as org_slug, o.name as org_name
        from alerts a
        join organizations o on o.id = a.org_id
        left join alert_rules r on r.id = a.rule_id
       where a.id = ${input.alertId} and a.org_id = ${input.orgId}`;
    if (!alert) return { skip: "alert_not_found" as const };
    if (alert.from_reprocessing) return { skip: "from_reprocessing" as const };
    if (alert.status === "suppressed") return { skip: "suppressed" as const };
    if (input.reason === "created" && alert.status === "resolved") return { skip: "already_resolved" as const };
    if (input.reason === "escalated" && alert.status !== "open") return { skip: "no_longer_open" as const };

    const roles = input.reason === "created" ? (alert.notify_roles ?? DEFAULT_NOTIFY_ROLES) : (alert.escalate_to_roles ?? DEFAULT_ESCALATE_ROLES);
    const recipients = await tx<{ user_id: string; email: string; role: string }[]>`
      select m.user_id, u.email, m.role::text as role
        from memberships m join auth_user u on u.id = m.user_id
       where m.org_id = ${input.orgId} and m.role::text = any(${roles})
         and not auth_account_disabled(m.user_id)
         and (not m.aoi_restricted or exists (
               select 1 from aoi_grants g where g.membership_id = m.id and g.aoi_id = ${alert.aoi_id}))
       order by m.user_id`;

    const escalation = input.reason === "escalated";
    if (alert.notify_in_app ?? true) {
      for (const r of recipients) {
        const rows = escalation
          ? await tx`
              insert into notifications (org_id, user_id, alert_id, channel, status, status_reason, sent_at)
              values (${input.orgId}, ${r.user_id}, ${alert.id}, 'in_app', 'sent', 'escalated', now())
              on conflict (alert_id, user_id, channel) do update
                 set status = 'sent', status_reason = 'escalated', sent_at = now(), read_at = null
               where coalesce(notifications.status_reason, '') <> 'escalated'
              returning id`
          : await tx`
              insert into notifications (org_id, user_id, alert_id, channel, status, sent_at)
              values (${input.orgId}, ${r.user_id}, ${alert.id}, 'in_app', 'sent', now())
              on conflict (alert_id, user_id, channel) do nothing
              returning id`;
        result.inApp += rows.length;
      }
    }
    if (alert.notify_email ?? false) {
      const status = config ? "pending" : "skipped";
      const reasonText = config ? (escalation ? "escalated" : null) : escalation ? `escalated: ${unavailable}` : unavailable;
      for (const r of recipients) {
        // Username-only accounts have no deliverable address (see PLACEHOLDER_EMAIL_DOMAIN).
        const noAddress = isPlaceholderEmail(r.email);
        const rStatus = noAddress ? "skipped" : status;
        const rReason = noAddress ? (escalation ? "escalated: no_email_address" : "no_email_address") : reasonText;
        if (escalation) {
          await tx`
            insert into notifications (org_id, user_id, alert_id, channel, status, status_reason)
            values (${input.orgId}, ${r.user_id}, ${alert.id}, 'email', ${rStatus}, ${rReason})
            on conflict (alert_id, user_id, channel) do update
               set status = ${rStatus}, status_reason = ${rReason}, sent_at = null
             where coalesce(notifications.status_reason, '') not like 'escalated%'`;
        } else {
          await tx`
            insert into notifications (org_id, user_id, alert_id, channel, status, status_reason)
            values (${input.orgId}, ${r.user_id}, ${alert.id}, 'email', ${rStatus}, ${rReason})
            on conflict (alert_id, user_id, channel) do nothing`;
        }
      }
    }
    const pending = await tx<{ id: string; user_id: string; email: string; role: string }[]>`
      select n.id, n.user_id, u.email, m.role::text as role
        from notifications n
        join auth_user u on u.id = n.user_id
        join memberships m on m.org_id = n.org_id and m.user_id = n.user_id
       where n.org_id = ${input.orgId} and n.alert_id = ${alert.id} and n.channel = 'email' and n.status = 'pending'`;
    const [skipped] = await tx<{ n: number }[]>`
      select count(*)::int as n from notifications
       where org_id = ${input.orgId} and alert_id = ${alert.id} and channel = 'email' and status = 'skipped'`;
    result.emailSkipped = skipped?.n ?? 0;
    return { alert, pending };
  });

  if ("skip" in plan) {
    log.debug("notifications.skip", { alertId: input.alertId, reason: plan.skip });
    return { ...result, status: "skipped", reason: plan.skip };
  }

  // 2. Send pending emails outside any transaction.
  let retryable = 0;
  if (plan.pending.length && config) {
    const send = deps.sendEmail ?? resendSender(config.apiKey);
    for (const p of plan.pending) {
      const { subject, text } = renderAlertEmail({
        alertId: plan.alert.id,
        orgSlug: plan.alert.org_slug,
        orgName: plan.alert.org_name,
        title: plan.alert.title,
        severity: plan.alert.severity,
        ruleName: plan.alert.rule_name,
        recipientRole: p.role,
        explanation: plan.alert.explanation,
        eventAt: plan.alert.event_at,
        observedAt: plan.alert.observed_at,
        ingestedAt: plan.alert.ingested_at,
        processedAt: plan.alert.processed_at,
        createdAt: plan.alert.created_at,
        reason: input.reason,
        escalateAfterHours: plan.alert.escalate_after_hours,
      });
      const sent = await send({ from: config.from, to: p.email, subject, text, idempotencyKey: `oryn-alert-${plan.alert.id}-${p.user_id}-${input.reason}` });
      const prefix = input.reason === "escalated" ? "escalated" : null;
      await withTenant({ orgId: input.orgId }, (tx) => recordSend(tx, input.orgId, p.id, sent, prefix));
      if (sent.ok) result.emailSent++;
      else if (sent.retryable) retryable++;
      else result.emailFailed++;
    }
  }

  // 3. Mark delivery complete when nothing is pending and someone was actually notified.
  await withTenant({ orgId: input.orgId }, async (tx) => {
    await tx`
      update alerts set notified_at = coalesce(notified_at, now())
       where id = ${plan.alert.id} and org_id = ${input.orgId}
         and not exists (select 1 from notifications n where n.alert_id = ${plan.alert.id} and n.status = 'pending')
         and exists (select 1 from notifications n where n.alert_id = ${plan.alert.id} and n.status = 'sent')`;
  });
  if (retryable > 0) throw new Error(`${retryable} email notification(s) failed with a retryable error; will retry.`);
  return result;
}

async function recordSend(tx: Tx, orgId: string, notificationId: string, r: Awaited<ReturnType<EmailSender>>, prefix: string | null) {
  const tag = (s: string) => (prefix ? `${prefix}: ${s}` : s);
  if (r.ok) {
    await tx`update notifications set status = 'sent', sent_at = now(), status_reason = ${prefix} where id = ${notificationId} and org_id = ${orgId}`;
  } else if (r.retryable) {
    await tx`update notifications set status_reason = ${tag(`retrying: ${r.error}`).slice(0, 500)} where id = ${notificationId} and org_id = ${orgId}`;
  } else {
    await tx`update notifications set status = 'failed', status_reason = ${tag(r.error).slice(0, 500)} where id = ${notificationId} and org_id = ${orgId}`;
  }
}
