/**
 * Alert email: plain-text rendering and delivery through Resend.
 *
 * Guarantees
 *  - The email states what, where, when (acquisition time separately from
 *    ORYN's ingestion/processing times), why, the basis of the alert
 *    (observation / model estimate / forecast / official warning / candidate
 *    change / data gap), certainty, limitations, and links to the evidence.
 *  - Email is sent only when RESEND_API_KEY and ORYN_EMAIL_FROM are set.
 *  - Each send carries an Idempotency-Key so a retried job does not send a
 *    duplicate within Resend's idempotency window.
 */
import { env } from "@/server/config/env";
import { integrationEnabled } from "@/server/integrations";
import { BASIS_LABEL, when, type AlertExplanation } from "@/server/alerts/explain";

export type EmailMessage = { from: string; to: string; subject: string; text: string; idempotencyKey: string };

export type EmailSendResult = { ok: true; providerId: string | null } | { ok: false; retryable: boolean; error: string };

export type EmailSender = (msg: EmailMessage) => Promise<EmailSendResult>;

export type EmailConfig = { apiKey: string; from: string };

/** Resend configuration, or null when email is not configured or not yet verified in production. */
export function emailConfig(): EmailConfig | null {
  const apiKey = env.resendApiKey();
  const from = env.emailFrom();
  return apiKey && from && integrationEnabled("email") ? { apiKey, from } : null;
}

/** Why email is unavailable, for the notification's recorded status. */
export function emailUnavailableReason(): "email_not_configured" | "email_not_verified" {
  return env.resendApiKey() && env.emailFrom() ? "email_not_verified" : "email_not_configured";
}

export const RESEND_ENDPOINT = "https://api.resend.com/emails";

export function resendSender(apiKey: string, fetchImpl: typeof fetch = fetch): EmailSender {
  return async (msg) => {
    try {
      const res = await fetchImpl(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": msg.idempotencyKey,
        },
        body: JSON.stringify({ from: msg.from, to: [msg.to], subject: msg.subject, text: msg.text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { id?: string };
        return { ok: true, providerId: body.id ?? null };
      }
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      return { ok: false, retryable: res.status === 429 || res.status >= 500, error: `Resend HTTP ${res.status}${detail ? `: ${detail}` : ""}` };
    } catch (err) {
      return { ok: false, retryable: true, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

export type AlertEmailInput = {
  alertId: string;
  orgSlug: string;
  orgName: string;
  title: string;
  severity: string;
  ruleName: string | null;
  recipientRole: string;
  explanation: AlertExplanation;
  eventAt: Date | null;
  observedAt: Date | null;
  ingestedAt: Date | null;
  processedAt: Date | null;
  createdAt: Date;
  reason: "created" | "escalated";
  escalateAfterHours?: number | null;
};

export function alertUrl(orgSlug: string, alertId: string): string {
  return `${env.authBaseUrl().replace(/\/$/, "")}/app/${orgSlug}/alerts/${alertId}`;
}

/** Render the alert email. Pure apart from reading the public base URL. */
export function renderAlertEmail(a: AlertEmailInput): { subject: string; text: string } {
  const e = a.explanation;
  const link = alertUrl(a.orgSlug, a.alertId);
  const sev = a.severity.toUpperCase();
  const subject = `${a.reason === "escalated" ? "[ORYN] Escalated — " : "[ORYN] "}${sev}: ${a.title}`.slice(0, 250);
  const lines: string[] = [];
  if (a.reason === "escalated") {
    lines.push(
      `This alert has not been acknowledged${a.escalateAfterHours ? ` within ${a.escalateAfterHours} hours` : ""} and has been escalated to you.`,
      "",
    );
  }
  lines.push(a.title, "", `Severity: ${a.severity}`, `Basis: ${BASIS_LABEL[e.basis] ?? e.basis}`, "");
  lines.push("WHAT", e.what, "", "WHERE", e.where, "");
  lines.push("WHEN");
  if (a.eventAt) lines.push(`  Event time (as reported by the source): ${when(a.eventAt)}`);
  lines.push(`  ${e.basis === "forecast" ? "Forecast issued" : "Data acquired"}: ${when(a.observedAt)}`);
  lines.push(`  Received by ORYN: ${when(a.ingestedAt)}`);
  lines.push(`  Processed by ORYN: ${when(a.processedAt)}`);
  lines.push(`  Alert raised: ${when(a.createdAt)}`, "");
  lines.push("WHY", e.why, "", "CERTAINTY", e.certainty, "", "SUGGESTED ACTION", e.suggested_action, "");
  lines.push("EVIDENCE");
  for (const ev of e.evidence.slice(0, 12)) lines.push(`  - ${ev.label}${ev.observed_at ? ` (${when(new Date(ev.observed_at))})` : ""}`);
  if (e.evidence.length > 12) lines.push(`  - … and ${e.evidence.length - 12} more`);
  lines.push(`  Full evidence and history: ${link}`, "");
  if (e.limitations.length) {
    lines.push("LIMITATIONS");
    for (const l of e.limitations) lines.push(`  - ${l}`);
    lines.push("");
  }
  lines.push(
    `You receive this because your role (${a.recipientRole}) in ${a.orgName} is notified by ${a.ruleName ? `the rule "${a.ruleName}"` : "this alert's rule"}.`,
  );
  return { subject, text: lines.join("\n") };
}
