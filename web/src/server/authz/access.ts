/**
 * Organization access resolution — the single place that decides who may act
 * for which organization with which permissions.
 *
 * Framework-independent (no Next.js imports) so it is used identically by
 * pages, server actions, route handlers, the worker, and tests.
 *
 * Rules
 *  - A user acts for an org only through a membership. Platform admins do NOT
 *    get implicit access to tenant data.
 *  - Unknown org and non-member are indistinguishable (404), so org slugs
 *    cannot be probed.
 *  - API keys act for exactly one org, with their scopes intersected with
 *    the API scope allowlist.
 *  - Account restrictions (db table account_controls) are loaded here, not
 *    passed in, so no caller can skip them:
 *      disabled              → no access at all (sessions are also revoked)
 *      trial_only            → only trial organizations; others are 404
 *      must_change_password  → no non-trial organization until the owner
 *                              replaces the administrator-issued password
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { API_KEY_SCOPES, ROLE_PERMISSIONS, type OrgRole, type Permission } from "@/lib/authz";
import type { AuditActor } from "@/server/audit";
import { withSystem, withTenant, withUser, type TenantContext, type Tx } from "@/server/db/client";

export class AccessError extends Error {
  constructor(
    public readonly status: 401 | 403 | 404,
    public readonly code: "unauthenticated" | "forbidden" | "not_found" | "invalid_credentials" | "password_change_required",
    message: string,
  ) {
    super(message);
    this.name = "AccessError";
  }
}

export type OrgKind = "agriculture" | "municipal" | "infrastructure" | "enterprise" | "public_sector";

export type OrgSummary = {
  id: string;
  slug: string;
  name: string;
  kind: OrgKind;
  isSynthetic: boolean;
  /** Trial workspace: synthetic data, open to trial-only accounts. */
  isTrial: boolean;
  settings: OrgSettings;
  onboardingCompletedAt: Date | null;
};

export type OrgSettings = {
  exportsEnabled?: boolean;
  retention?: { auditDays?: number; newsDays?: number; exportsDays?: number; jobsDays?: number };
  timezone?: string;
};

export type Principal =
  | { type: "user"; userId: string; label: string; isPlatformAdmin: boolean }
  | { type: "api_key"; apiKeyId: string; label: string; scopes: Permission[]; createdBy: string | null }
  /** An operator running a CLI with database owner credentials (never reachable over HTTP). */
  | { type: "operator"; label: string };

export type RequestMeta = { ip: string | null; userAgent: string | null };

export type OrgAccess = {
  principal: Principal;
  org: OrgSummary;
  role: OrgRole | null;
  membershipId: string | null;
  aoiRestricted: boolean;
  permissions: ReadonlySet<Permission>;
  tenant: TenantContext;
  meta: RequestMeta;
  can(p: Permission): boolean;
  assert(p: Permission): void;
  auditActor(): AuditActor;
  /** Run a unit of work in this org's tenant context. */
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
};

type OrgRow = {
  id: string;
  slug: string;
  name: string;
  kind: OrgKind;
  is_synthetic: boolean;
  is_trial: boolean;
  settings: OrgSettings;
  onboarding_completed_at: Date | null;
};

function toOrg(r: OrgRow): OrgSummary {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    kind: r.kind,
    isSynthetic: r.is_synthetic,
    isTrial: r.is_trial,
    settings: r.settings ?? {},
    onboardingCompletedAt: r.onboarding_completed_at,
  };
}

function buildAccess(args: {
  principal: Principal;
  org: OrgSummary;
  role: OrgRole | null;
  membershipId: string | null;
  aoiRestricted: boolean;
  permissions: Set<Permission>;
  meta: RequestMeta;
}): OrgAccess {
  const tenant: TenantContext = {
    orgId: args.org.id,
    userId: args.principal.type === "user" ? args.principal.userId : null,
  };
  return {
    ...args,
    tenant,
    can: (p) => args.permissions.has(p),
    assert(p) {
      if (!args.permissions.has(p)) throw new AccessError(403, "forbidden", `This action requires the "${p}" permission.`);
    },
    auditActor() {
      const p = args.principal;
      if (p.type === "user") return { type: "user", userId: p.userId, label: p.label };
      if (p.type === "api_key") return { type: "api_key", apiKeyId: p.apiKeyId, label: p.label };
      return { type: "system", label: p.label };
    },
    tx: (fn) => withTenant(tenant, fn),
  };
}

type AccountRestrictions = { must_change_password: boolean; trial_only: boolean; disabled: boolean };

export async function listUserOrgs(userId: string): Promise<(OrgSummary & { role: OrgRole; passwordChangeRequired: boolean })[]> {
  return withUser(userId, async (tx) => {
    const rows = await tx<(OrgRow & { role: OrgRole } & AccountRestrictions)[]>`
      select o.id, o.slug::text as slug, o.name, o.kind, o.is_synthetic, o.is_trial, o.settings, o.onboarding_completed_at, m.role,
             coalesce(c.must_change_password, false) as must_change_password, coalesce(c.trial_only, false) as trial_only,
             c.disabled_at is not null as disabled
        from memberships m join organizations o on o.id = m.org_id
        left join account_controls c on c.user_id = m.user_id
       where m.user_id = ${userId} and o.archived_at is null
       order by o.name`;
    return rows
      .filter((r) => !r.disabled && (!r.trial_only || r.is_trial))
      .map((r) => ({ ...toOrg(r), role: r.role, passwordChangeRequired: r.must_change_password && !r.is_trial }));
  });
}

export async function resolveUserOrgAccess(
  user: { id: string; label: string; isPlatformAdmin: boolean },
  slug: string,
  meta: RequestMeta,
): Promise<OrgAccess> {
  if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(slug)) throw new AccessError(404, "not_found", "Organization not found.");
  const row = await withUser(user.id, async (tx) => {
    const [r] = await tx<(OrgRow & { role: OrgRole; membership_id: string; aoi_restricted: boolean } & AccountRestrictions)[]>`
      select o.id, o.slug::text as slug, o.name, o.kind, o.is_synthetic, o.is_trial, o.settings, o.onboarding_completed_at,
             m.role, m.id as membership_id, m.aoi_restricted,
             coalesce(c.must_change_password, false) as must_change_password, coalesce(c.trial_only, false) as trial_only,
             c.disabled_at is not null as disabled
        from organizations o join memberships m on m.org_id = o.id and m.user_id = ${user.id}
        left join account_controls c on c.user_id = m.user_id
       where o.slug = ${slug} and o.archived_at is null`;
    return r;
  });
  if (!row) throw new AccessError(404, "not_found", "Organization not found.");
  if (row.disabled) throw new AccessError(401, "unauthenticated", "Authentication required.");
  // Indistinguishable from a missing organization (also blocked by a database trigger).
  if (row.trial_only && !row.is_trial) throw new AccessError(404, "not_found", "Organization not found.");
  if (row.must_change_password && !row.is_trial) {
    throw new AccessError(403, "password_change_required", "Change the password your administrator issued before opening this organization.");
  }
  return buildAccess({
    principal: { type: "user", userId: user.id, label: user.label, isPlatformAdmin: user.isPlatformAdmin },
    org: toOrg(row),
    role: row.role,
    membershipId: row.membership_id,
    aoiRestricted: row.aoi_restricted,
    permissions: new Set(ROLE_PERMISSIONS[row.role]),
    meta,
  });
}

/**
 * Organization access for an operator CLI (e.g. creating a trial workspace's
 * sample areas). Never used by HTTP code paths; the operator already holds
 * database owner credentials.
 */
export async function operatorOrgAccess(slug: string, label: string): Promise<OrgAccess> {
  const org = await withSystem("operator.org_access", async (tx) => {
    const [o] = await tx<OrgRow[]>`
      select id, slug::text as slug, name, kind, is_synthetic, is_trial, settings, onboarding_completed_at
        from organizations where slug = ${slug} and archived_at is null`;
    return o;
  });
  if (!org) throw new AccessError(404, "not_found", "Organization not found.");
  return buildAccess({
    principal: { type: "operator", label },
    org: toOrg(org),
    role: null,
    membershipId: null,
    aoiRestricted: false,
    permissions: new Set(ROLE_PERMISSIONS.org_admin),
    meta: { ip: null, userAgent: "cli" },
  });
}

// ── API keys ───────────────────────────────────────────────────
// Format: oryn_<prefix:8 lowercase alnum>_<secret:43 base64url chars>

const KEY_RE = /^oryn_([a-z0-9]{8})_([A-Za-z0-9_-]{43})$/;

export function hashApiSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

export function parseApiKey(token: string): { prefix: string; secret: string } | null {
  const m = KEY_RE.exec(token.trim());
  return m ? { prefix: m[1]!, secret: m[2]! } : null;
}

export async function resolveApiKeyAccess(token: string, slug: string | null, meta: RequestMeta): Promise<OrgAccess> {
  const parsed = parseApiKey(token);
  if (!parsed) throw new AccessError(401, "invalid_credentials", "Invalid API key.");

  const key = await withSystem("api_key.lookup", async (tx) => {
    const [k] = await tx<
      { id: string; org_id: string; key_hash: Buffer; scopes: string[]; expires_at: Date | null; revoked_at: Date | null; created_by: string | null }[]
    >`select * from api_key_by_prefix(${parsed.prefix})`;
    return k;
  });
  const candidate = hashApiSecret(parsed.secret);
  // Compare against a dummy digest when the prefix is unknown so timing does
  // not reveal which prefixes exist.
  const stored = key?.key_hash ?? Buffer.alloc(32);
  const match = stored.length === candidate.length && timingSafeEqual(stored, candidate);
  if (!key || !match || key.revoked_at || (key.expires_at && key.expires_at.getTime() <= Date.now())) {
    throw new AccessError(401, "invalid_credentials", "Invalid API key.");
  }

  const org = await withTenant({ orgId: key.org_id }, async (tx) => {
    const [o] = await tx<OrgRow[]>`
      select id, slug::text as slug, name, kind, is_synthetic, is_trial, settings, onboarding_completed_at
        from organizations where id = ${key.org_id} and archived_at is null`;
    if (o) {
      await tx`update api_keys set last_used_at = now()
                where id = ${key.id} and (last_used_at is null or last_used_at < now() - interval '5 minutes')`;
    }
    return o;
  });
  if (!org) throw new AccessError(401, "invalid_credentials", "Invalid API key.");
  if (slug && org.slug !== slug) throw new AccessError(404, "not_found", "Organization not found.");

  const allowed = new Set<Permission>(API_KEY_SCOPES);
  const scopes = key.scopes.filter((s): s is Permission => allowed.has(s as Permission));
  return buildAccess({
    principal: { type: "api_key", apiKeyId: key.id, label: `API key ${parsed.prefix}`, scopes, createdBy: key.created_by },
    org: toOrg(org),
    role: null,
    membershipId: null,
    aoiRestricted: false,
    permissions: new Set(scopes),
    meta,
  });
}
