"use server";

import { revalidatePath } from "next/cache";
import { acknowledgeAlert, addAlertNote, assignAlert, reopenAlert, resolveAlert } from "@/server/alerts/service";
import { createAlertRule, deleteAlertRule, setAlertRuleEnabled } from "@/server/alerts/rule-service";
import { getSessionUser } from "@/server/auth/session";
import { orgAction } from "@/server/authz/next";
import { markRead } from "@/server/notifications/service";

export async function alertAction(slug: string, alertId: string, op: { kind: "ack" | "resolve" | "reopen" | "note" | "assign"; note?: string; userId?: string | null }) {
  const perm = op.kind === "note" ? "notes.write" : "alerts.respond";
  const r = await orgAction(slug, perm, async (access) => {
    if (op.kind === "ack") await acknowledgeAlert(access, alertId, op.note);
    else if (op.kind === "resolve") await resolveAlert(access, alertId, op.note ?? "");
    else if (op.kind === "reopen") await reopenAlert(access, alertId, op.note);
    else if (op.kind === "assign") await assignAlert(access, alertId, op.userId ?? null);
    else await addAlertNote(access, alertId, op.note ?? "");
    return null;
  });
  revalidatePath(`/app/${slug}/alerts/${alertId}`);
  revalidatePath(`/app/${slug}/alerts`);
  return r;
}

export async function createRuleAction(slug: string, input: Record<string, unknown>) {
  const r = await orgAction(slug, "alert_rules.manage", (access) => createAlertRule(access, input as never).then((x) => ({ id: x.id })));
  if (r.ok) revalidatePath(`/app/${slug}/alerts/rules`);
  return r;
}

export async function ruleToggleAction(slug: string, ruleId: string, enabled: boolean) {
  const r = await orgAction(slug, "alert_rules.manage", (access) => setAlertRuleEnabled(access, ruleId, enabled).then(() => null));
  revalidatePath(`/app/${slug}/alerts/rules`);
  return r;
}

export async function ruleDeleteAction(slug: string, ruleId: string) {
  const r = await orgAction(slug, "alert_rules.manage", (access) => deleteAlertRule(access, ruleId).then(() => null));
  revalidatePath(`/app/${slug}/alerts/rules`);
  return r;
}

export async function markNotificationsReadAction(slug: string) {
  const user = await getSessionUser();
  if (!user) return { ok: false as const, error: "Sign in again.", code: "unauthenticated" };
  const r = await orgAction(slug, "alerts.read", (access) => markRead(user.id, access.org.id));
  revalidatePath(`/app/${slug}`, "layout");
  return r;
}
