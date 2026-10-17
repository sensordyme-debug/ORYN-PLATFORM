/**
 * Transactional email through Resend's REST API. Returns "not_configured"
 * rather than pretending to send when RESEND_API_KEY / ORYN_EMAIL_FROM are
 * unset, so callers can record an honest delivery status.
 */
import { env } from "@/server/config/env";
import { integrationEnabled } from "@/server/integrations";

export type EmailResult = "sent" | "not_configured";

/** Configured AND (outside production, or verified in this deployment — see src/server/integrations.ts). */
export function emailConfigured(): boolean {
  return Boolean(env.resendApiKey() && env.emailFrom()) && integrationEnabled("email");
}

export async function sendEmail(msg: { to: string[]; subject: string; text: string }): Promise<EmailResult> {
  const key = env.resendApiKey();
  const from = env.emailFrom();
  if (!key || !from || !integrationEnabled("email")) return "not_configured";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: msg.to, subject: msg.subject, text: msg.text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Email provider responded ${res.status}`);
  return "sent";
}
