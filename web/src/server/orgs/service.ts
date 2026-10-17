/**
 * Organization administration: members, roles, invitations, API keys,
 * geographic access grants, and settings.
 *
 * Invariants
 *  - An organization always keeps at least one org_admin.
 *  - Invitation and API-key secrets are random 256-bit values shown once;
 *    only SHA-256 digests are stored.
 *  - Accepting an invitation requires the signed-in account's email to match
 *    the invited email.
 *  - Nothing here sends email unless an administrator explicitly asks and an
 *    email provider is configured.
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { isPlaceholderEmail } from "@/lib/accounts";
import { API_KEY_SCOPES, ORG_ROLES, type OrgRole, type Permission } from "@/lib/authz";
import { recordAudit } from "@/server/audit";
import { hashApiSecret, type OrgAccess, type OrgSettings } from "@/server/authz/access";
import { env } from "@/server/config/env";
import { jsonb, withSystem, withTenant, type Tx } from "@/server/db/client";
import { DomainError, notFoundError } from "@/server/errors";
import { emailConfigured } from "@/server/email";
import { log } from "@/server/log";

export type Member = {
  membershipId: string;
  userId: string;
  name: string;
  /** Null for username-only accounts. */
  email: string | null;
  username: string | null;
  role: OrgRole;
  aoiRestricted: boolean;
  grantedAoiIds: string[];
  createdAt: Date;
};

export async function listMembers(access: OrgAccess): Promise<Member[]> {
  access.assert("members.read");
  return access.tx(async (tx) => {
    const rows = await tx<
      { id: string; user_id: string; name: string; email: string; username: string | null; role: OrgRole; aoi_restricted: boolean; created_at: Date; grants: string[] | null }[]
    >`
      select m.id, m.user_id, u.name, u.email, u."displayUsername" as username, m.role, m.aoi_restricted, m.created_at,
             (select array_agg(g.aoi_id) from aoi_grants g where g.membership_id = m.id) as grants
        from memberships m join auth_user u on u.id = m.user_id
       where m.org_id = ${access.org.id}
       order by u.name`;
    return rows.map((r) => ({
      membershipId: r.id,
      userId: r.user_id,
      name: r.name,
      email: isPlaceholderEmail(r.email) ? null : r.email,
      username: r.username,
      role: r.role,
      aoiRestricted: r.aoi_restricted,
      grantedAoiIds: r.grants ?? [],
      createdAt: r.created_at,
    }));
  });
}

async function adminCount(tx: Tx, orgId: string): Promise<number> {
  const [r] = await tx<{ n: number }[]>`select count(*)::int as n from memberships where org_id = ${orgId} and role = 'org_admin'`;
  return r?.n ?? 0;
}

export const memberUpdateSchema = z.object({
  role: z.enum(ORG_ROLES).optional(),
  aoiRestricted: z.boolean().optional(),
  grantedAoiIds: z.array(z.uuid()).max(5000).optional(),
});

export async function updateMember(access: OrgAccess, membershipId: string, raw: z.input<typeof memberUpdateSchema>) {
  access.assert("members.manage");
  const input = memberUpdateSchema.parse(raw);
  return access.tx(async (tx) => {
    const [m] = await tx<{ role: OrgRole; user_id: string }[]>`
      select role, user_id from memberships where id = ${membershipId} and org_id = ${access.org.id} for update`;
    if (!m) throw notFoundError("Member");
    if (input.role && m.role === "org_admin" && input.role !== "org_admin" && (await adminCount(tx, access.org.id)) <= 1) {
      throw new DomainError("last_admin", "An organization must keep at least one administrator.", 409);
    }
    await tx`
      update memberships set
        role = coalesce(${input.role ?? null}::org_role, role),
        aoi_restricted = coalesce(${input.aoiRestricted ?? null}, aoi_restricted)
      where id = ${membershipId} and org_id = ${access.org.id}`;
    if (input.grantedAoiIds) {
      const valid = await tx<{ id: string }[]>`
        select id from aois where org_id = ${access.org.id} and id = any(${input.grantedAoiIds}::uuid[])`;
      if (valid.length !== new Set(input.grantedAoiIds).size) throw new DomainError("invalid", "One or more areas do not exist.", 422);
      await tx`delete from aoi_grants where membership_id = ${membershipId} and org_id = ${access.org.id}`;
      for (const v of valid) {
        await tx`insert into aoi_grants (org_id, membership_id, aoi_id, granted_by)
                 values (${access.org.id}, ${membershipId}, ${v.id}, ${access.tenant.userId ?? null})`;
      }
    }
    await recordAudit(tx, {
      orgId: access.org.id,
      actor: access.auditActor(),
      action: "member.update",
      targetType: "membership",
      targetId: membershipId,
      metadata: { user_id: m.user_id, from_role: m.role, ...input, grantedAoiIds: input.grantedAoiIds?.length },
      ...access.meta,
    });
  });
}

export async function removeMember(access: OrgAccess, membershipId: string) {
  access.assert("members.manage");
  return access.tx(async (tx) => {
    const [m] = await tx<{ role: OrgRole; user_id: string }[]>`
      select role, user_id from memberships where id = ${membershipId} and org_id = ${access.org.id} for update`;
    if (!m) throw notFoundError("Member");
    if (m.role === "org_admin" && (await adminCount(tx, access.org.id)) <= 1) {
      throw new DomainError("last_admin", "An organization must keep at least one administrator.", 409);
    }
    await tx`delete from memberships where id = ${membershipId} and org_id = ${access.org.id}`;
    await recordAudit(tx, {
      orgId: access.org.id,
      actor: access.auditActor(),
      action: "member.remove",
      targetType: "membership",
      targetId: membershipId,
      metadata: { user_id: m.user_id, role: m.role },
      ...access.meta,
    });
  });
}

// ── Invitations ────────────────────────────────────────────────

const INVITE_TTL_DAYS = 7;
export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

export const invitationSchema = z.object({
  email: z
    .email("Enter a valid email address.")
    .trim()
    .toLowerCase()
    .max(200)
    .refine((e) => !isPlaceholderEmail(e), "Enter a deliverable email address."),
  role: z.enum(ORG_ROLES),
  sendEmail: z.boolean().default(false),
});

export type InvitationView = { id: string; email: string; role: OrgRole; createdAt: Date; expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null };

export async function listInvitations(access: OrgAccess): Promise<InvitationView[]> {
  access.assert("members.manage");
  return access.tx(async (tx) => {
    const rows = await tx<{ id: string; email: string; role: OrgRole; created_at: Date; expires_at: Date; accepted_at: Date | null; revoked_at: Date | null }[]>`
      select id, email::text as email, role, created_at, expires_at, accepted_at, revoked_at
        from invitations where org_id = ${access.org.id} order by created_at desc limit 200`;
    return rows.map((r) => ({ id: r.id, email: r.email, role: r.role, createdAt: r.created_at, expiresAt: r.expires_at, acceptedAt: r.accepted_at, revokedAt: r.revoked_at }));
  });
}

/** Create an invitation. Returns the one-time link; it is never retrievable again. */
export async function createInvitation(access: OrgAccess, raw: z.input<typeof invitationSchema>) {
  access.assert("members.manage");
  const input = invitationSchema.parse(raw);
  const token = randomBytes(32).toString("base64url");
  const link = `${env.authBaseUrl().replace(/\/$/, "")}/invite/${token}`;
  const id = await access.tx(async (tx) => {
    const [existing] = await tx`
      select 1 from memberships m join auth_user u on u.id = m.user_id
       where m.org_id = ${access.org.id} and lower(u.email) = ${input.email}`;
    if (existing) throw new DomainError("already_member", "That person is already a member.", 409);
    await tx`update invitations set revoked_at = now()
              where org_id = ${access.org.id} and email = ${input.email} and accepted_at is null and revoked_at is null`;
    const [row] = await tx<{ id: string }[]>`
      insert into invitations (org_id, email, role, token_hash, invited_by, expires_at)
      values (${access.org.id}, ${input.email}, ${input.role}, ${sha256(token)}, ${access.tenant.userId ?? null},
              now() + make_interval(days => ${INVITE_TTL_DAYS}))
      returning id`;
    await recordAudit(tx, {
      orgId: access.org.id,
      actor: access.auditActor(),
      action: "invitation.create",
      targetType: "invitation",
      targetId: row!.id,
      metadata: { email: input.email, role: input.role, email_requested: input.sendEmail },
      ...access.meta,
    });
    return row!.id;
  });

  let emailed: "sent" | "not_requested" | "not_configured" | "failed" = "not_requested";
  if (input.sendEmail) {
    emailed = await sendInvitationEmail(input.email, access.org.name, link).catch((err) => {
      log.error("invitation.email_failed", { err });
      return "failed" as const;
    });
  }
  return { id, link, expiresInDays: INVITE_TTL_DAYS, emailed };
}

async function sendInvitationEmail(to: string, orgName: string, link: string): Promise<"sent" | "not_configured"> {
  const key = env.resendApiKey();
  const from = env.emailFrom();
  if (!key || !from || !emailConfigured()) return "not_configured";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `You've been invited to ${orgName} on ORYN`,
      text: `You have been invited to join ${orgName} on ORYN.\n\nAccept the invitation (valid for ${INVITE_TTL_DAYS} days):\n${link}\n\nIf you weren't expecting this, you can ignore this email.`,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Resend responded ${res.status}`);
  return "sent";
}

export async function revokeInvitation(access: OrgAccess, invitationId: string) {
  access.assert("members.manage");
  return access.tx(async (tx) => {
    const rows = await tx`update invitations set revoked_at = now()
                           where id = ${invitationId} and org_id = ${access.org.id} and accepted_at is null and revoked_at is null
                           returning id`;
    if (rows.length === 0) throw notFoundError("Pending invitation");
    await recordAudit(tx, { orgId: access.org.id, actor: access.auditActor(), action: "invitation.revoke", targetType: "invitation", targetId: invitationId, ...access.meta });
  });
}

export type InvitationLookup =
  | { state: "valid"; id: string; orgId: string; orgName: string; email: string; role: OrgRole; expiresAt: Date }
  | { state: "expired" | "revoked" | "accepted" | "unknown" };

export async function lookupInvitation(token: string): Promise<InvitationLookup> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { state: "unknown" };
  const row = await withSystem("invitation.lookup", async (tx) => {
    const [r] = await tx<{ id: string; org_id: string; org_name: string; email: string; role: OrgRole; expires_at: Date; accepted_at: Date | null; revoked_at: Date | null }[]>`
      select * from invitation_by_token(${sha256(token)})`;
    return r;
  });
  if (!row) return { state: "unknown" };
  if (row.accepted_at) return { state: "accepted" };
  if (row.revoked_at) return { state: "revoked" };
  if (row.expires_at.getTime() <= Date.now()) return { state: "expired" };
  return { state: "valid", id: row.id, orgId: row.org_id, orgName: row.org_name, email: row.email, role: row.role, expiresAt: row.expires_at };
}

/** Accept an invitation for a signed-in user. Returns the org slug. */
export async function acceptInvitation(token: string, user: { id: string; email: string }, meta: { ip: string | null; userAgent: string | null }) {
  const inv = await lookupInvitation(token);
  if (inv.state !== "valid") throw new DomainError("invitation_invalid", `This invitation is ${inv.state === "unknown" ? "not valid" : inv.state}.`, 409);
  if (inv.email.toLowerCase() !== user.email.toLowerCase()) {
    throw new DomainError("email_mismatch", `This invitation was sent to ${inv.email}. Sign in with that account to accept it.`, 409);
  }
  return withTenant({ orgId: inv.orgId, userId: user.id }, async (tx) => {
    const updated = await tx`update invitations set accepted_at = now(), accepted_by = ${user.id}
                              where id = ${inv.id} and accepted_at is null and revoked_at is null and expires_at > now()
                              returning id`;
    if (updated.length === 0) throw new DomainError("invitation_invalid", "This invitation is no longer valid.", 409);
    await tx`insert into memberships (org_id, user_id, role, created_by) values (${inv.orgId}, ${user.id}, ${inv.role}, 'invitation')
             on conflict (org_id, user_id) do nothing`;
    // The invitation link proved control of the address it was delivered to.
    await tx`update auth_user set "emailVerified" = true where id = ${user.id}`;
    await recordAudit(tx, {
      orgId: inv.orgId,
      actor: { type: "user", userId: user.id, label: user.email },
      action: "invitation.accept",
      targetType: "invitation",
      targetId: inv.id,
      metadata: { role: inv.role },
      ...meta,
    });
    const [o] = await tx<{ slug: string }[]>`select slug::text as slug from organizations where id = ${inv.orgId}`;
    return o!.slug;
  });
}

// ── API keys ───────────────────────────────────────────────────

export const apiKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(API_KEY_SCOPES as [Permission, ...Permission[]])).min(1),
  expiresInDays: z.number().int().min(1).max(365).nullable().default(90),
});

export type ApiKeyView = { id: string; name: string; prefix: string; scopes: string[]; createdAt: Date; expiresAt: Date | null; lastUsedAt: Date | null; revokedAt: Date | null };

export async function listApiKeys(access: OrgAccess): Promise<ApiKeyView[]> {
  access.assert("apikeys.manage");
  return access.tx(async (tx) => {
    const rows = await tx<{ id: string; name: string; prefix: string; scopes: string[]; created_at: Date; expires_at: Date | null; last_used_at: Date | null; revoked_at: Date | null }[]>`
      select id, name, prefix, scopes, created_at, expires_at, last_used_at, revoked_at
        from api_keys where org_id = ${access.org.id} order by created_at desc`;
    return rows.map((r) => ({ id: r.id, name: r.name, prefix: r.prefix, scopes: r.scopes, createdAt: r.created_at, expiresAt: r.expires_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at }));
  });
}

/** Create an API key. The full key is returned exactly once. */
export async function createApiKey(access: OrgAccess, raw: z.input<typeof apiKeySchema>) {
  access.assert("apikeys.manage");
  const input = apiKeySchema.parse(raw);
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const prefix = Array.from(randomBytes(8), (b) => alphabet[b % alphabet.length]).join("");
  const secret = randomBytes(32).toString("base64url");
  const key = `oryn_${prefix}_${secret}`;
  const id = await access.tx(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into api_keys (org_id, name, prefix, key_hash, scopes, created_by, expires_at)
      values (${access.org.id}, ${input.name}, ${prefix}, ${hashApiSecret(secret)}, ${input.scopes}, ${access.tenant.userId ?? null},
              ${input.expiresInDays ? tx`now() + make_interval(days => ${input.expiresInDays})` : tx`null`})
      returning id`;
    await recordAudit(tx, {
      orgId: access.org.id,
      actor: access.auditActor(),
      action: "apikey.create",
      targetType: "api_key",
      targetId: row!.id,
      metadata: { name: input.name, prefix, scopes: input.scopes, expires_in_days: input.expiresInDays },
      ...access.meta,
    });
    return row!.id;
  });
  return { id, key, prefix };
}

export async function revokeApiKey(access: OrgAccess, id: string) {
  access.assert("apikeys.manage");
  return access.tx(async (tx) => {
    const rows = await tx`update api_keys set revoked_at = now() where id = ${id} and org_id = ${access.org.id} and revoked_at is null returning prefix`;
    if (rows.length === 0) throw notFoundError("Active API key");
    await recordAudit(tx, { orgId: access.org.id, actor: access.auditActor(), action: "apikey.revoke", targetType: "api_key", targetId: id, ...access.meta });
  });
}

// ── Settings ───────────────────────────────────────────────────

export const settingsSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  exportsEnabled: z.boolean().optional(),
  timezone: z.string().max(64).refine((tz) => Intl.supportedValuesOf("timeZone").includes(tz), "Unknown time zone").optional(),
  retention: z
    .object({
      auditDays: z.number().int().min(90).max(3650).optional(),
      newsDays: z.number().int().min(7).max(3650).optional(),
      exportsDays: z.number().int().min(1).max(90).optional(),
      jobsDays: z.number().int().min(7).max(3650).optional(),
    })
    .optional(),
});

export async function updateSettings(access: OrgAccess, raw: z.input<typeof settingsSchema>) {
  access.assert("org.manage");
  const input = settingsSchema.parse(raw);
  return access.tx(async (tx) => {
    const [o] = await tx<{ settings: OrgSettings }[]>`select settings from organizations where id = ${access.org.id} for update`;
    const next: OrgSettings = {
      ...(o?.settings ?? {}),
      ...(input.exportsEnabled !== undefined ? { exportsEnabled: input.exportsEnabled } : {}),
      ...(input.timezone ? { timezone: input.timezone } : {}),
      ...(input.retention ? { retention: { ...(o?.settings?.retention ?? {}), ...input.retention } } : {}),
    };
    await tx`update organizations set settings = ${jsonb(next)}::jsonb, name = coalesce(${input.name ?? null}, name) where id = ${access.org.id}`;
    await recordAudit(tx, { orgId: access.org.id, actor: access.auditActor(), action: "org.settings_update", targetType: "organization", targetId: access.org.id, metadata: input, ...access.meta });
    return next;
  });
}

export async function completeOnboarding(access: OrgAccess) {
  access.assert("org.manage");
  await access.tx(async (tx) => {
    await tx`update organizations set onboarding_completed_at = coalesce(onboarding_completed_at, now()) where id = ${access.org.id}`;
    await recordAudit(tx, { orgId: access.org.id, actor: access.auditActor(), action: "org.onboarding_complete", targetType: "organization", targetId: access.org.id, ...access.meta });
  });
}

// ── Platform administration (platform admins only; cross-tenant) ──

export const orgCreateSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,47}$/, "Use 2–48 lowercase letters, digits, and hyphens."),
  name: z.string().trim().min(2).max(120),
  kind: z.enum(["agriculture", "municipal", "infrastructure", "enterprise", "public_sector"]),
  isSynthetic: z.boolean().default(false),
});

export async function createOrganization(admin: { id: string; label: string; isPlatformAdmin: boolean; mustChangePassword?: boolean }, raw: z.input<typeof orgCreateSchema>, meta: { ip: string | null; userAgent: string | null }) {
  if (!admin.isPlatformAdmin || admin.mustChangePassword) throw new DomainError("forbidden", "Only platform administrators can create organizations.", 422);
  const input = orgCreateSchema.parse(raw);
  return withSystem("platform.create_org", async (tx) => {
    const [o] = await tx<{ id: string }[]>`
      insert into organizations (slug, name, kind, is_synthetic) values (${input.slug}, ${input.name}, ${input.kind}, ${input.isSynthetic})
      returning id`;
    await recordAudit(tx, {
      orgId: o!.id,
      actor: { type: "user", userId: admin.id, label: admin.label },
      action: "platform.org_create",
      targetType: "organization",
      targetId: o!.id,
      metadata: input,
      ...meta,
    });
    return { id: o!.id, slug: input.slug };
  });
}

export async function listAllOrganizations(admin: { isPlatformAdmin: boolean }) {
  if (!admin.isPlatformAdmin) throw new DomainError("forbidden", "Only platform administrators can list organizations.", 422);
  return withSystem("platform.list_orgs", (tx) =>
    tx<{ id: string; slug: string; name: string; kind: string; is_synthetic: boolean; is_trial: boolean; created_at: Date; members: number; aois: number; admins: number }[]>`
      select o.id, o.slug::text as slug, o.name, o.kind, o.is_synthetic, o.is_trial, o.created_at,
             (select count(*)::int from memberships m where m.org_id = o.id) as members,
             (select count(*)::int from memberships m where m.org_id = o.id and m.role = 'org_admin') as admins,
             (select count(*)::int from aois a where a.org_id = o.id and a.status = 'active') as aois
        from organizations o where o.archived_at is null order by o.name`,
  );
}

/** Platform admin: invite an organization's first administrator (cross-tenant, audited). */
export async function invitePlatformOrgAdmin(admin: { id: string; label: string; isPlatformAdmin: boolean; mustChangePassword?: boolean }, orgId: string, email: string, meta: { ip: string | null; userAgent: string | null }) {
  if (!admin.isPlatformAdmin || admin.mustChangePassword) throw new DomainError("forbidden", "Only platform administrators can do this.", 422);
  const parsed = invitationSchema.shape.email.parse(email);
  const token = randomBytes(32).toString("base64url");
  await withSystem("platform.invite_admin", async (tx) => {
    await tx`update invitations set revoked_at = now() where org_id = ${orgId} and email = ${parsed} and accepted_at is null and revoked_at is null`;
    const [row] = await tx<{ id: string }[]>`
      insert into invitations (org_id, email, role, token_hash, invited_by, expires_at)
      values (${orgId}, ${parsed}, 'org_admin', ${sha256(token)}, ${admin.id}, now() + make_interval(days => ${INVITE_TTL_DAYS}))
      returning id`;
    await recordAudit(tx, {
      orgId,
      actor: { type: "user", userId: admin.id, label: admin.label },
      action: "platform.invite_org_admin",
      targetType: "invitation",
      targetId: row!.id,
      metadata: { email: parsed },
      ...meta,
    });
  });
  return { link: `${env.authBaseUrl().replace(/\/$/, "")}/invite/${token}`, expiresInDays: INVITE_TTL_DAYS };
}
