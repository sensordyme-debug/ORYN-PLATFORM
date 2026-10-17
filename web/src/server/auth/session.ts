import "server-only";
import { headers } from "next/headers";
import { clientIp } from "@/server/http";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getAuth } from "@/server/auth/auth";
import { isPlaceholderEmail } from "@/lib/accounts";
import { withUser } from "@/server/db/client";
import { log } from "@/server/log";

export type SessionUser = {
  id: string;
  /** Stored address; a non-deliverable placeholder for username-only accounts. */
  email: string;
  /** The real address, or null for username-only accounts. */
  contactEmail: string | null;
  username: string | null;
  displayUsername: string | null;
  name: string;
  /** How the account is named in audit records and the UI: its username, else its email. */
  label: string;
  isPlatformAdmin: boolean;
  /** An administrator issued the current password; non-trial organizations stay closed until it is changed. */
  mustChangePassword: boolean;
  /** Confined to trial organizations. */
  trialOnly: boolean;
  sessionId: string;
};

/**
 * Resolve the account behind a request's session cookie, with its platform
 * role and restrictions. A disabled account has its sessions deleted at the
 * moment it is disabled; if one were somehow still presented it is revoked
 * here and treated as signed out.
 */
export async function loadSessionUser(h: Headers): Promise<SessionUser | null> {
  const session = await getAuth().api.getSession({ headers: h });
  if (!session) return null;
  const u = session.user as typeof session.user & { username?: string | null; displayUsername?: string | null };
  const state = await withUser(u.id, async (tx) => {
    const [r] = await tx<{ is_admin: boolean; must_change_password: boolean; trial_only: boolean; disabled: boolean }[]>`
      select exists (select 1 from platform_admins where user_id = ${u.id}) as is_admin,
             coalesce(c.must_change_password, false) as must_change_password,
             coalesce(c.trial_only, false) as trial_only,
             coalesce(c.disabled_at is not null, false) as disabled
        from (select 1) one left join account_controls c on c.user_id = ${u.id}`;
    if (r?.disabled) await tx`delete from auth_session where "userId" = ${u.id}`;
    return r!;
  });
  if (state.disabled) {
    log.warn("auth.disabled_session_revoked", { userId: u.id });
    return null;
  }
  return {
    id: u.id,
    email: u.email,
    contactEmail: isPlaceholderEmail(u.email) ? null : u.email,
    username: u.username ?? null,
    displayUsername: u.displayUsername ?? null,
    name: u.name,
    label: u.username ?? u.email,
    isPlatformAdmin: state.is_admin,
    mustChangePassword: state.must_change_password,
    trialOnly: state.trial_only,
    sessionId: session.session.id,
  };
}

/** The signed-in user for this request, or null. Memoized per request. */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => loadSessionUser(await headers()));

/** For pages: redirect to sign-in when there is no session. */
export async function requireUser(nextPath?: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect(nextPath ? `/login?next=${encodeURIComponent(nextPath)}` : "/login");
  return user;
}

/** Where an account with an administrator-issued password is sent first. */
export function passwordChangePath(nextPath?: string): string {
  return `/app/account?required=1${nextPath ? `&next=${encodeURIComponent(nextPath)}` : ""}`;
}

/** For platform-administration pages: platform admins only, after any required password change. */
export async function requirePlatformAdmin(nextPath: string): Promise<SessionUser | null> {
  const user = await requireUser(nextPath);
  if (!user.isPlatformAdmin) return null;
  if (user.mustChangePassword) redirect(passwordChangePath(nextPath));
  return user;
}

export async function requestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  return { ip: clientIp(h), userAgent: h.get("user-agent")?.slice(0, 300) ?? null };
}
