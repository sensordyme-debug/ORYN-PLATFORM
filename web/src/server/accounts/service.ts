/**
 * Administrator-provisioned accounts (partner and trial accounts).
 *
 * There is no self-registration. Accounts are created here — by a platform
 * administrator in the web UI or by an operator with the CLI
 * (scripts/oryn/accounts.ts) — or by accepting an invitation.
 *
 *  - Passwords are hashed by Better Auth (scrypt); this module never stores,
 *    logs, or audits a password. A generated temporary password is returned
 *    once to the caller and nowhere else.
 *  - An administrator-issued password must be changed by its owner before the
 *    account can open any non-trial organization (must_change_password,
 *    enforced in src/server/authz/access.ts).
 *  - Disabling an account, resetting its password, or lifting its trial-only
 *    restriction revokes all of its sessions immediately.
 *  - Every change is written to the platform audit trail (org_id null) and to
 *    the trail of each organization the account belongs to.
 *  - Usernames are case-insensitive: stored lower-case (the form Better Auth's
 *    username plugin signs in with) with the administrator's casing kept as
 *    the display username.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { ORG_ROLES, type OrgRole } from "@/lib/authz";
import { recordAudit, type AuditActor } from "@/server/audit";
import { authContext } from "@/server/auth/core";
import { isPlaceholderEmail, PLACEHOLDER_EMAIL_DOMAIN } from "@/lib/accounts";
import { trustedUserCreation } from "@/server/auth/options";
import { AccessError } from "@/server/authz/access";
import { withSystem, type Tx } from "@/server/db/client";
import { DomainError, notFoundError } from "@/server/errors";

// ── Validation ─────────────────────────────────────────────────

export const usernameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.]{3,30}$/, "Use 3–30 letters, digits, dots, or underscores.");
export const normalizeUsername = (u: string) => u.trim().toLowerCase();
export const passwordSchema = z.string().min(12, "Use at least 12 characters.").max(128, "Use at most 128 characters.");
export const placeholderEmail = (username: string) => `${normalizeUsername(username)}@${PLACEHOLDER_EMAIL_DOMAIN}`;
/** 144 bits from the CSPRNG, URL-safe (24 characters). */
export const generateTemporaryPassword = () => randomBytes(18).toString("base64url");
const orgSlugSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,47}$/, "Unknown organization.");

// ── Who is acting ──────────────────────────────────────────────

export type AccountOperator =
  | { type: "platform_admin"; userId: string; label: string; isPlatformAdmin: boolean; mustChangePassword: boolean }
  | { type: "cli"; label: string };

type Meta = { ip: string | null; userAgent: string | null };
const NO_META: Meta = { ip: null, userAgent: null };

function authorize(op: AccountOperator) {
  if (op.type === "platform_admin" && (!op.isPlatformAdmin || op.mustChangePassword)) {
    throw new AccessError(403, "forbidden", "Only platform administrators can manage accounts.");
  }
}

function actorOf(op: AccountOperator): AuditActor {
  return op.type === "platform_admin" ? { type: "user", userId: op.userId, label: op.label } : { type: "system", label: op.label };
}

// ── Lookup ─────────────────────────────────────────────────────

type AccountRow = {
  id: string;
  email: string;
  username: string | null;
  display_username: string | null;
  name: string;
  must_change_password: boolean;
  trial_only: boolean;
  disabled_at: Date | null;
};

/**
 * An account by username, by email (the reference contains "@"), or by user
 * id (longer than any username: ids are 32+ characters, usernames at most 30).
 */
async function findAccount(tx: Tx, ref: string): Promise<AccountRow | null> {
  const raw = ref.trim();
  const value = raw.toLowerCase();
  const where = value.includes("@") ? tx`lower(u.email) = ${value}` : raw.length > 30 ? tx`u.id = ${raw}` : tx`u.username = ${value}`;
  const [row] = await tx<AccountRow[]>`
    select u.id, u.email, u.username, u."displayUsername" as display_username, u.name,
           coalesce(c.must_change_password, false) as must_change_password,
           coalesce(c.trial_only, false) as trial_only, c.disabled_at
      from auth_user u left join account_controls c on c.user_id = u.id
     where ${where}`;
  return row ?? null;
}

async function requireAccount(tx: Tx, ref: string): Promise<AccountRow> {
  const a = await findAccount(tx, ref);
  if (!a) throw notFoundError("Account");
  return a;
}

const handle = (a: Pick<AccountRow, "username" | "email">) => a.username ?? a.email;

async function memberOrgIds(tx: Tx, userId: string): Promise<string[]> {
  return (await tx<{ org_id: string }[]>`select org_id from memberships where user_id = ${userId}`).map((r) => r.org_id);
}

/** Platform trail, plus the trail of every organization the account belongs to. */
async function auditAccount(
  tx: Tx,
  op: AccountOperator,
  meta: Meta,
  action: string,
  account: Pick<AccountRow, "id" | "username" | "email">,
  metadata: Record<string, unknown> = {},
) {
  const entry = { actor: actorOf(op), action, targetType: "user", targetId: account.id, metadata: { account: handle(account), ...metadata }, ...meta };
  await recordAudit(tx, { ...entry, orgId: null });
  for (const orgId of await memberOrgIds(tx, account.id)) await recordAudit(tx, { ...entry, orgId });
}

async function revokeSessions(tx: Tx, userId: string): Promise<number> {
  // Sessions live only in PostgreSQL (no secondary storage, no cookie cache),
  // so deleting the rows ends them on the next request.
  return (await tx`delete from auth_session where "userId" = ${userId} returning id`).length;
}

async function upsertControls(tx: Tx, userId: string, set: { mustChangePassword?: boolean; trialOnly?: boolean; passwordChangedNow?: boolean }) {
  await tx`
    insert into account_controls (user_id, must_change_password, trial_only, password_changed_at)
    values (${userId}, ${set.mustChangePassword ?? false}, ${set.trialOnly ?? false}, ${set.passwordChangedNow ? tx`now()` : tx`null`})
    on conflict (user_id) do update set
      must_change_password = coalesce(${set.mustChangePassword ?? null}::boolean, account_controls.must_change_password),
      trial_only = coalesce(${set.trialOnly ?? null}::boolean, account_controls.trial_only),
      password_changed_at = ${set.passwordChangedNow ? tx`now()` : tx`account_controls.password_changed_at`}`;
}

// ── Creating credentials (shared with invitations, CLI, seed) ──

/**
 * Create a user with a password through Better Auth's own adapter and hasher
 * (the same steps as its sign-up endpoint, which is disabled). User and
 * credential rows are written in one transaction; the username plugin's
 * database hook validates and normalizes the username.
 */
export async function createCredentialUser(
  input: { email: string; name: string; password: string; username?: string | null; emailVerified?: boolean },
  reason: string,
): Promise<{ id: string }> {
  const password = passwordSchema.parse(input.password);
  const email = z.email().parse(input.email.trim().toLowerCase());
  const ctx = await authContext();
  const hash = await ctx.password.hash(password);
  const id = ctx.generateId({ model: "user" }) || randomUUID();
  const user = {
    id,
    email,
    name: input.name.trim(),
    emailVerified: input.emailVerified ?? false,
    ...(input.username ? { username: input.username.trim(), displayUsername: input.username.trim() } : {}),
  } as unknown as Parameters<typeof ctx.internalAdapter.createOAuthUser>[0];
  try {
    await trustedUserCreation.run({ reason, email }, () =>
      ctx.internalAdapter.createOAuthUser(user, { providerId: "credential", accountId: id, password: hash }),
    );
  } catch (err) {
    const message = (err as { message?: string }).message ?? "";
    if (/already taken|already exists|duplicate key/i.test(message)) throw new DomainError("conflict", "That username or email is already in use.", 409);
    throw err;
  }
  return { id };
}

async function setCredentialPassword(userId: string, password: string) {
  const ctx = await authContext();
  const hash = await ctx.password.hash(passwordSchema.parse(password));
  if (await ctx.internalAdapter.findCredentialAccount(userId)) await ctx.internalAdapter.updatePassword(userId, hash);
  else await ctx.internalAdapter.linkAccount({ userId, providerId: "credential", accountId: userId, password: hash });
}

// ── Partner accounts ───────────────────────────────────────────

export const partnerAccountSchema = z.object({
  username: usernameSchema,
  name: z.string().trim().min(2, "Enter a name.").max(100),
  email: z
    .email("Enter a valid email address.")
    .trim()
    .toLowerCase()
    .max(200)
    .refine((e) => !isPlaceholderEmail(e), "Enter a real address or leave it blank.")
    .nullable()
    .default(null),
  orgSlug: orgSlugSchema.nullable().default(null),
  role: z.enum(ORG_ROLES).default("viewer"),
  trialOnly: z.boolean().default(false),
  requirePasswordChange: z.boolean().default(true),
});

export type CreateAccountResult = {
  userId: string;
  username: string;
  created: boolean;
  /** Only when this call generated the password; shown once, never stored. */
  temporaryPassword: string | null;
  membership: "created" | "existing" | "none";
  notes: string[];
};

/**
 * Create a partner (or trial) account, optionally with a membership.
 * Idempotent: if the username exists, its password and flags are left
 * unchanged and only a missing membership is added.
 */
export async function createPartnerAccount(
  op: AccountOperator,
  raw: z.input<typeof partnerAccountSchema>,
  opts: { password?: string | null } = {},
  meta: Meta = NO_META,
): Promise<CreateAccountResult> {
  authorize(op);
  const input = partnerAccountSchema.parse(raw);
  const username = normalizeUsername(input.username);

  const pre = await withSystem("accounts.create_check", async (tx) => {
    const existing = await findAccount(tx, username);
    const [org] = input.orgSlug
      ? await tx<{ id: string; is_trial: boolean; name: string }[]>`
          select id, is_trial, name from organizations where slug = ${input.orgSlug} and archived_at is null`
      : [];
    if (input.orgSlug && !org) throw new DomainError("not_found", "Organization not found.", 404);
    if (!existing && input.email) {
      const [taken] = await tx`select 1 from auth_user where lower(email) = ${input.email}`;
      if (taken) throw new DomainError("conflict", "An account with that email already exists.", 409);
    }
    return { existing, org: org ?? null };
  });
  const { existing, org } = pre;
  const trialOnly = existing ? existing.trial_only : input.trialOnly;
  if (org && trialOnly && !org.is_trial) {
    throw new DomainError("trial_restricted", "Trial-only accounts can only join trial organizations.", 409);
  }

  if (existing) {
    const notes = ["The account already exists; its password and restrictions were not changed."];
    const membership = !org
      ? ("none" as const)
      : await withSystem("accounts.ensure_membership", async (tx) => {
          const [m] = await tx<{ role: OrgRole }[]>`select role from memberships where org_id = ${org.id} and user_id = ${existing.id}`;
          if (m) {
            if (m.role !== input.role) notes.push(`Kept the existing ${m.role} role in ${input.orgSlug}; change roles explicitly.`);
            return "existing" as const;
          }
          await tx`insert into memberships (org_id, user_id, role, created_by) values (${org.id}, ${existing.id}, ${input.role}, ${op.label})`;
          await recordAudit(tx, { orgId: org.id, actor: actorOf(op), action: "member.add", targetType: "user", targetId: existing.id, metadata: { account: handle(existing), role: input.role }, ...meta });
          await recordAudit(tx, { orgId: null, actor: actorOf(op), action: "account.membership_set", targetType: "user", targetId: existing.id, metadata: { account: handle(existing), org: input.orgSlug, role: input.role }, ...meta });
          return "created" as const;
        });
    return { userId: existing.id, username: existing.username ?? username, created: false, temporaryPassword: null, membership, notes };
  }

  const generated = opts.password ? null : generateTemporaryPassword();
  const password = opts.password ?? generated!;
  const { id } = await createCredentialUser(
    { email: input.email ?? placeholderEmail(username), name: input.name, password, username: input.username, emailVerified: false },
    `provision:${op.type}`,
  );
  try {
    await withSystem("accounts.create", async (tx) => {
      await tx`insert into account_controls (user_id, must_change_password, trial_only, provisioned_by)
               values (${id}, ${input.requirePasswordChange}, ${input.trialOnly}, ${op.label})`;
      if (org) await tx`insert into memberships (org_id, user_id, role, created_by) values (${org.id}, ${id}, ${input.role}, ${op.label})`;
      const account = { id, username, email: input.email ?? placeholderEmail(username) };
      await auditAccount(tx, op, meta, "account.create", account, {
        org: input.orgSlug,
        role: org ? input.role : null,
        trial_only: input.trialOnly,
        must_change_password: input.requirePasswordChange,
        has_email: Boolean(input.email),
        password_source: generated ? "generated" : "provided",
      });
      if (org) await recordAudit(tx, { orgId: org.id, actor: actorOf(op), action: "member.add", targetType: "user", targetId: id, metadata: { account: username, role: input.role }, ...meta });
    });
  } catch (err) {
    // Do not leave a half-provisioned account (credentials without its restrictions).
    await withSystem("accounts.create_rollback", (tx) => tx`delete from auth_user where id = ${id}`);
    throw err;
  }
  return { userId: id, username, created: true, temporaryPassword: generated, membership: org ? "created" : "none", notes: [] };
}

/** Issue a new password. Revokes every session; by default the owner must change it at next sign-in. */
export async function resetAccountPassword(
  op: AccountOperator,
  ref: string,
  opts: { password?: string | null; requireChange?: boolean } = {},
  meta: Meta = NO_META,
): Promise<{ temporaryPassword: string | null; sessionsRevoked: number }> {
  authorize(op);
  const account = await withSystem("accounts.lookup", (tx) => requireAccount(tx, ref));
  const generated = opts.password ? null : generateTemporaryPassword();
  await setCredentialPassword(account.id, opts.password ?? generated!);
  const requireChange = opts.requireChange ?? true;
  const sessionsRevoked = await withSystem("accounts.reset_password", async (tx) => {
    await upsertControls(tx, account.id, { mustChangePassword: requireChange, passwordChangedNow: !requireChange });
    const n = await revokeSessions(tx, account.id);
    await auditAccount(tx, op, meta, "account.password_reset", account, { must_change_password: requireChange, sessions_revoked: n, password_source: generated ? "generated" : "provided" });
    return n;
  });
  return { temporaryPassword: generated, sessionsRevoked };
}

/**
 * Disable or re-enable an account. Disabling revokes its sessions and the API
 * keys it created (they would otherwise keep working for its organizations).
 */
export async function setAccountDisabled(
  op: AccountOperator,
  ref: string,
  disabled: boolean,
  opts: { reason?: string | null } = {},
  meta: Meta = NO_META,
): Promise<{ changed: boolean; sessionsRevoked: number; apiKeysRevoked: number }> {
  authorize(op);
  const reason = opts.reason ? z.string().trim().max(300).parse(opts.reason) || null : null;
  return withSystem("accounts.set_disabled", async (tx) => {
    const account = await requireAccount(tx, ref);
    if (op.type === "platform_admin" && account.id === op.userId) throw new DomainError("invalid", "You cannot disable your own account.", 409);
    if (Boolean(account.disabled_at) === disabled) return { changed: false, sessionsRevoked: 0, apiKeysRevoked: 0 };
    if (!disabled) {
      await tx`update account_controls set disabled_at = null, disabled_reason = null, disabled_by = null where user_id = ${account.id}`;
      await auditAccount(tx, op, meta, "account.enable", account);
      return { changed: true, sessionsRevoked: 0, apiKeysRevoked: 0 };
    }
    await tx`
      insert into account_controls (user_id, disabled_at, disabled_reason, disabled_by) values (${account.id}, now(), ${reason}, ${op.label})
      on conflict (user_id) do update set disabled_at = now(), disabled_reason = excluded.disabled_reason, disabled_by = excluded.disabled_by`;
    const sessionsRevoked = await revokeSessions(tx, account.id);
    const keys = await tx<{ id: string; org_id: string; prefix: string }[]>`
      update api_keys set revoked_at = now() where created_by = ${account.id} and revoked_at is null returning id, org_id, prefix`;
    for (const k of keys) {
      await recordAudit(tx, { orgId: k.org_id, actor: actorOf(op), action: "apikey.revoke", targetType: "api_key", targetId: k.id, metadata: { prefix: k.prefix, reason: "creator_account_disabled" }, ...meta });
    }
    await auditAccount(tx, op, meta, "account.disable", account, { reason, sessions_revoked: sessionsRevoked, api_keys_revoked: keys.length });
    return { changed: true, sessionsRevoked, apiKeysRevoked: keys.length };
  });
}

export async function revokeAccountSessions(op: AccountOperator, ref: string, meta: Meta = NO_META): Promise<{ sessionsRevoked: number }> {
  authorize(op);
  return withSystem("accounts.revoke_sessions", async (tx) => {
    const account = await requireAccount(tx, ref);
    const sessionsRevoked = await revokeSessions(tx, account.id);
    await auditAccount(tx, op, meta, "account.sessions_revoke", account, { sessions_revoked: sessionsRevoked });
    return { sessionsRevoked };
  });
}

async function lockOrg(tx: Tx, slug: string) {
  const [org] = await tx<{ id: string; is_trial: boolean }[]>`
    select id, is_trial from organizations where slug = ${orgSlugSchema.parse(slug)} and archived_at is null`;
  if (!org) throw new DomainError("not_found", "Organization not found.", 404);
  return org;
}

async function assertNotLastAdmin(tx: Tx, orgId: string, userId: string) {
  const [r] = await tx<{ n: number }[]>`
    select count(*)::int as n from memberships where org_id = ${orgId} and role = 'org_admin' and user_id <> ${userId}`;
  if ((r?.n ?? 0) === 0) throw new DomainError("last_admin", "An organization must keep at least one administrator.", 409);
}

/** Add the account to an organization, or change its role there. */
export async function setMembership(
  op: AccountOperator,
  ref: string,
  orgSlug: string,
  role: OrgRole,
  meta: Meta = NO_META,
): Promise<{ result: "added" | "updated" | "unchanged" }> {
  authorize(op);
  const parsedRole = z.enum(ORG_ROLES).parse(role);
  return withSystem("accounts.set_membership", async (tx) => {
    const account = await requireAccount(tx, ref);
    const org = await lockOrg(tx, orgSlug);
    // Also enforced by a database trigger; checked here for a clear message.
    if (account.trial_only && !org.is_trial) throw new DomainError("trial_restricted", "Trial-only accounts can only join trial organizations.", 409);
    const [m] = await tx<{ id: string; role: OrgRole }[]>`
      select id, role from memberships where org_id = ${org.id} and user_id = ${account.id} for update`;
    if (m?.role === parsedRole) return { result: "unchanged" as const };
    if (m) {
      if (m.role === "org_admin") await assertNotLastAdmin(tx, org.id, account.id);
      await tx`update memberships set role = ${parsedRole} where id = ${m.id}`;
      await recordAudit(tx, { orgId: org.id, actor: actorOf(op), action: "member.update", targetType: "membership", targetId: m.id, metadata: { user_id: account.id, account: handle(account), from_role: m.role, role: parsedRole }, ...meta });
    } else {
      await tx`insert into memberships (org_id, user_id, role, created_by) values (${org.id}, ${account.id}, ${parsedRole}, ${op.label})`;
      await recordAudit(tx, { orgId: org.id, actor: actorOf(op), action: "member.add", targetType: "user", targetId: account.id, metadata: { account: handle(account), role: parsedRole }, ...meta });
    }
    await recordAudit(tx, { orgId: null, actor: actorOf(op), action: "account.membership_set", targetType: "user", targetId: account.id, metadata: { account: handle(account), org: orgSlug, from_role: m?.role ?? null, role: parsedRole }, ...meta });
    return { result: m ? ("updated" as const) : ("added" as const) };
  });
}

export async function removeMembership(op: AccountOperator, ref: string, orgSlug: string, meta: Meta = NO_META): Promise<void> {
  authorize(op);
  await withSystem("accounts.remove_membership", async (tx) => {
    const account = await requireAccount(tx, ref);
    const org = await lockOrg(tx, orgSlug);
    const [m] = await tx<{ id: string; role: OrgRole }[]>`
      select id, role from memberships where org_id = ${org.id} and user_id = ${account.id} for update`;
    if (!m) throw notFoundError("Membership");
    if (m.role === "org_admin") await assertNotLastAdmin(tx, org.id, account.id);
    await recordAudit(tx, { orgId: org.id, actor: actorOf(op), action: "member.remove", targetType: "membership", targetId: m.id, metadata: { user_id: account.id, account: handle(account), role: m.role }, ...meta });
    await tx`delete from memberships where id = ${m.id}`;
    await recordAudit(tx, { orgId: null, actor: actorOf(op), action: "account.membership_remove", targetType: "user", targetId: account.id, metadata: { account: handle(account), org: orgSlug, role: m.role }, ...meta });
  });
}

/**
 * Confine an account to trial organizations, or lift that restriction.
 * Lifting it also requires a password change and revokes sessions: a trial
 * password may have been shared, so it must never open real customer data.
 */
export async function setTrialOnly(op: AccountOperator, ref: string, trialOnly: boolean, meta: Meta = NO_META): Promise<{ sessionsRevoked: number }> {
  authorize(op);
  return withSystem("accounts.set_trial_only", async (tx) => {
    const account = await requireAccount(tx, ref);
    if (account.trial_only === trialOnly) return { sessionsRevoked: 0 };
    await upsertControls(tx, account.id, trialOnly ? { trialOnly: true } : { trialOnly: false, mustChangePassword: true });
    const sessionsRevoked = trialOnly ? 0 : await revokeSessions(tx, account.id);
    await auditAccount(tx, op, meta, "account.trial_only_set", account, { trial_only: trialOnly, ...(trialOnly ? {} : { must_change_password: true, sessions_revoked: sessionsRevoked }) });
    return { sessionsRevoked };
  });
}

/** Give an existing (e.g. invitation-created) account a username so it can sign in with one. */
export async function setUsername(op: AccountOperator, ref: string, newUsername: string, meta: Meta = NO_META): Promise<void> {
  authorize(op);
  const display = usernameSchema.parse(newUsername);
  const username = normalizeUsername(display);
  await withSystem("accounts.set_username", async (tx) => {
    const account = await requireAccount(tx, ref);
    const [taken] = await tx`select 1 from auth_user where username = ${username} and id <> ${account.id}`;
    if (taken) throw new DomainError("conflict", "That username is already in use.", 409);
    await tx`update auth_user set "username" = ${username}, "displayUsername" = ${display}, "updatedAt" = now() where id = ${account.id}`;
    await auditAccount(tx, op, meta, "account.username_set", account, { from: account.username, to: username });
  });
}

export async function accountExists(op: AccountOperator, ref: string): Promise<boolean> {
  authorize(op);
  return withSystem("accounts.exists", async (tx) => Boolean(await findAccount(tx, ref)));
}

// ── Listing (platform administration) ──────────────────────────

export type AccountView = {
  id: string;
  username: string | null;
  displayUsername: string | null;
  name: string;
  /** Null for username-only accounts (their stored address is a non-deliverable placeholder). */
  email: string | null;
  createdAt: Date;
  mustChangePassword: boolean;
  trialOnly: boolean;
  disabledAt: Date | null;
  disabledReason: string | null;
  isPlatformAdmin: boolean;
  activeSessions: number;
  lastSessionAt: Date | null;
  memberships: { slug: string; name: string; role: OrgRole; isTrial: boolean }[];
};

export async function listAccounts(op: AccountOperator): Promise<AccountView[]> {
  authorize(op);
  return withSystem("accounts.list", async (tx) => {
    const rows = await tx<
      {
        id: string; username: string | null; display_username: string | null; name: string; email: string; created_at: Date;
        must_change_password: boolean; trial_only: boolean; disabled_at: Date | null; disabled_reason: string | null;
        is_platform_admin: boolean; active_sessions: number; last_session_at: Date | null;
        memberships: { slug: string; name: string; role: OrgRole; isTrial: boolean }[];
      }[]
    >`
      select u.id, u.username, u."displayUsername" as display_username, u.name, u.email, u."createdAt" as created_at,
             coalesce(c.must_change_password, false) as must_change_password, coalesce(c.trial_only, false) as trial_only,
             c.disabled_at, c.disabled_reason,
             exists (select 1 from platform_admins p where p.user_id = u.id) as is_platform_admin,
             (select count(*)::int from auth_session s where s."userId" = u.id and s."expiresAt" > now()) as active_sessions,
             (select max(s."createdAt") from auth_session s where s."userId" = u.id) as last_session_at,
             coalesce((select json_agg(json_build_object('slug', o.slug, 'name', o.name, 'role', m.role, 'isTrial', o.is_trial) order by o.name)
                         from memberships m join organizations o on o.id = m.org_id where m.user_id = u.id), '[]'::json) as memberships
        from auth_user u left join account_controls c on c.user_id = u.id
       order by coalesce(u.username, u.email)`;
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      displayUsername: r.display_username,
      name: r.name,
      email: isPlaceholderEmail(r.email) ? null : r.email,
      createdAt: r.created_at,
      mustChangePassword: r.must_change_password,
      trialOnly: r.trial_only,
      disabledAt: r.disabled_at,
      disabledReason: r.disabled_reason,
      isPlatformAdmin: r.is_platform_admin,
      activeSessions: r.active_sessions,
      lastSessionAt: r.last_session_at,
      memberships: r.memberships,
    }));
  });
}

export async function listAccountEvents(op: AccountOperator, limit = 50) {
  authorize(op);
  return withSystem("accounts.events", (tx) =>
    tx<{ id: string; action: string; actor_label: string | null; metadata: Record<string, unknown>; created_at: Date }[]>`
      select id, action, actor_label, metadata, created_at from audit_events
       where org_id is null and (action like 'account.%' or action like 'platform.admin_%')
       order by id desc limit ${Math.min(Math.max(limit, 1), 200)}`,
  );
}

// ── Trial workspaces ───────────────────────────────────────────

export const trialOrgSchema = z.object({
  slug: orgSlugSchema.default("oryn-trial"),
  name: z.string().trim().min(2).max(120).default("ORYN Trial Workspace"),
  kind: z.enum(["agriculture", "municipal", "infrastructure", "enterprise", "public_sector"]).default("agriculture"),
});

/**
 * Ensure a trial organization exists. A trial organization is synthetic
 * (sample data only) by database constraint. An existing organization is
 * converted only if it is already synthetic and `convertSynthetic` is set.
 */
export async function ensureTrialOrganization(
  op: AccountOperator,
  raw: z.input<typeof trialOrgSchema>,
  opts: { convertSynthetic?: boolean } = {},
  meta: Meta = NO_META,
): Promise<{ id: string; slug: string; created: boolean }> {
  authorize(op);
  const input = trialOrgSchema.parse(raw);
  return withSystem("accounts.trial_org", async (tx) => {
    const [o] = await tx<{ id: string; is_trial: boolean; is_synthetic: boolean }[]>`
      select id, is_trial, is_synthetic from organizations where slug = ${input.slug}`;
    if (o?.is_trial) return { id: o.id, slug: input.slug, created: false };
    if (o) {
      if (!o.is_synthetic || !opts.convertSynthetic) {
        throw new DomainError("conflict", `Organization ${input.slug} exists and is not a trial organization${o.is_synthetic ? " (pass the convert option to make this synthetic organization a trial workspace)" : "; real organizations are never converted"}.`, 409);
      }
      await tx`update organizations set is_trial = true where id = ${o.id}`;
      await recordAudit(tx, { orgId: o.id, actor: actorOf(op), action: "platform.org_mark_trial", targetType: "organization", targetId: o.id, ...meta });
      return { id: o.id, slug: input.slug, created: false };
    }
    const [n] = await tx<{ id: string }[]>`
      insert into organizations (slug, name, kind, is_synthetic, is_trial, settings, onboarding_completed_at)
      values (${input.slug}, ${input.name}, ${input.kind}, true, true, ${tx.json({ timezone: "America/New_York", exportsEnabled: true })}, now())
      returning id`;
    await recordAudit(tx, { orgId: n!.id, actor: actorOf(op), action: "platform.org_create", targetType: "organization", targetId: n!.id, metadata: { ...input, trial: true, synthetic: true }, ...meta });
    return { id: n!.id, slug: input.slug, created: true };
  });
}
