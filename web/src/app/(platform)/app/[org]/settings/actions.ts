"use server";

import { revalidatePath } from "next/cache";
import type { OrgRole, Permission } from "@/lib/authz";
import { orgAction, type ActionResult } from "@/server/authz/next";
import {
  createApiKey,
  createInvitation,
  removeMember,
  revokeApiKey,
  revokeInvitation,
  updateMember,
  updateSettings,
} from "@/server/orgs/service";

const done = (slug: string, path = "settings") => revalidatePath(`/app/${slug}/${path}`);

export async function updateSettingsAction(slug: string, _: unknown, form: FormData): Promise<ActionResult<null>> {
  const num = (k: string) => (form.get(k) ? Number(form.get(k)) : undefined);
  const r = await orgAction(slug, "org.manage", (access) =>
    updateSettings(access, {
      name: String(form.get("name") ?? "") || undefined,
      exportsEnabled: form.get("exportsEnabled") === "on",
      timezone: String(form.get("timezone") ?? "") || undefined,
      retention: { auditDays: num("auditDays"), newsDays: num("newsDays"), exportsDays: num("exportsDays"), jobsDays: num("jobsDays") },
    }).then(() => null),
  );
  if (r.ok) done(slug);
  return r;
}

export async function inviteAction(slug: string, _: unknown, form: FormData) {
  const r = await orgAction(slug, "members.manage", (access) =>
    createInvitation(access, {
      email: String(form.get("email") ?? ""),
      role: String(form.get("role") ?? "viewer") as OrgRole,
      sendEmail: form.get("sendEmail") === "on",
    }),
  );
  if (r.ok) done(slug, "settings/members");
  return r;
}

export async function revokeInvitationAction(slug: string, id: string) {
  const r = await orgAction(slug, "members.manage", (access) => revokeInvitation(access, id).then(() => null));
  if (r.ok) done(slug, "settings/members");
  return r;
}

export async function updateMemberAction(slug: string, membershipId: string, patch: { role?: OrgRole; aoiRestricted?: boolean; grantedAoiIds?: string[] }) {
  const r = await orgAction(slug, "members.manage", (access) => updateMember(access, membershipId, patch).then(() => null));
  if (r.ok) done(slug, "settings/members");
  return r;
}

export async function removeMemberAction(slug: string, membershipId: string) {
  const r = await orgAction(slug, "members.manage", (access) => removeMember(access, membershipId).then(() => null));
  if (r.ok) done(slug, "settings/members");
  return r;
}

export async function createApiKeyAction(slug: string, _: unknown, form: FormData) {
  const expires = String(form.get("expiresInDays") ?? "90");
  const r = await orgAction(slug, "apikeys.manage", (access) =>
    createApiKey(access, {
      name: String(form.get("name") ?? ""),
      scopes: form.getAll("scopes").map(String) as Permission[],
      expiresInDays: expires === "never" ? null : Number(expires),
    }),
  );
  if (r.ok) done(slug, "settings/api-keys");
  return r;
}

export async function revokeApiKeyAction(slug: string, id: string) {
  const r = await orgAction(slug, "apikeys.manage", (access) => revokeApiKey(access, id).then(() => null));
  if (r.ok) done(slug, "settings/api-keys");
  return r;
}
