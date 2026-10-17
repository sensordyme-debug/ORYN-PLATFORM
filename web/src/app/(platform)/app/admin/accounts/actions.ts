"use server";

import { revalidatePath } from "next/cache";
import type { OrgRole } from "@/lib/authz";
import {
  createPartnerAccount,
  removeMembership,
  resetAccountPassword,
  revokeAccountSessions,
  setAccountDisabled,
  setMembership,
  setTrialOnly,
  type AccountOperator,
  type CreateAccountResult,
} from "@/server/accounts/service";
import { getSessionUser, requestMeta } from "@/server/auth/session";
import { AccessError } from "@/server/authz/access";
import { toActionError, type ActionResult } from "@/server/authz/next";

/** Every action re-checks the caller server-side; the service checks again. */
async function operator(): Promise<AccountOperator> {
  const user = await getSessionUser();
  if (!user) throw new AccessError(401, "unauthenticated", "Your session has expired. Sign in again.");
  if (!user.isPlatformAdmin || user.mustChangePassword) throw new AccessError(403, "forbidden", "Only platform administrators can manage accounts.");
  return { type: "platform_admin", userId: user.id, label: user.label, isPlatformAdmin: user.isPlatformAdmin, mustChangePassword: user.mustChangePassword };
}

async function run<T>(fn: (op: AccountOperator, meta: { ip: string | null; userAgent: string | null }) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await fn(await operator(), await requestMeta());
    revalidatePath("/app/admin/accounts");
    return { ok: true, data };
  } catch (err) {
    return toActionError(err);
  }
}

export async function createAccountAction(_: unknown, form: FormData): Promise<ActionResult<CreateAccountResult>> {
  const text = (k: string) => String(form.get(k) ?? "").trim();
  return run((op, meta) =>
    createPartnerAccount(
      op,
      {
        username: text("username"),
        name: text("name"),
        email: text("email") || null,
        orgSlug: text("org") || null,
        role: (text("role") || "viewer") as OrgRole,
        trialOnly: form.get("trialOnly") === "on",
        requirePasswordChange: true,
      },
      // The web UI never accepts an administrator-typed password: one is
      // generated and shown once.
      {},
      meta,
    ),
  );
}

export async function resetPasswordAction(userId: string) {
  return run((op, meta) => resetAccountPassword(op, userId, { requireChange: true }, meta));
}

export async function setDisabledAction(userId: string, disabled: boolean, reason: string | null) {
  return run((op, meta) => setAccountDisabled(op, userId, disabled, { reason }, meta));
}

export async function revokeSessionsAction(userId: string) {
  return run((op, meta) => revokeAccountSessions(op, userId, meta));
}

export async function setMembershipAction(userId: string, orgSlug: string, role: OrgRole) {
  return run((op, meta) => setMembership(op, userId, orgSlug, role, meta));
}

export async function removeMembershipAction(userId: string, orgSlug: string) {
  return run((op, meta) => removeMembership(op, userId, orgSlug, meta));
}

export async function setTrialOnlyAction(userId: string, trialOnly: boolean) {
  return run((op, meta) => setTrialOnly(op, userId, trialOnly, meta));
}
