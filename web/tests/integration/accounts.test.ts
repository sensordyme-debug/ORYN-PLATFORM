/**
 * Administrator-provisioned accounts, exercised through Better Auth's real
 * HTTP handler (behind ORYN's endpoint allowlist) and the account service.
 */
import { betterAuth } from "better-auth";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountExists,
  createPartnerAccount,
  ensureTrialOrganization,
  removeMembership,
  resetAccountPassword,
  revokeAccountSessions,
  setAccountDisabled,
  setMembership,
  setTrialOnly,
  type AccountOperator,
} from "@/server/accounts/service";
import { changeOwnPassword } from "@/server/accounts/self-service";
import { coreAuth } from "@/server/auth/core";
import { handleAuthRequest } from "@/server/auth/http";
import { buildAuthOptions, closeAuthPool, trustedUserCreation } from "@/server/auth/options";
import { AccessError, listUserOrgs, resolveUserOrgAccess } from "@/server/authz/access";
import { addMember, closeTestDb, createOrg, createUser, meta, ownerSql, resetDb } from "../helpers/db";

const BASE = "http://localhost:3000";
const CLI: AccountOperator = { type: "cli", label: "cli:test" };
const PASSWORD = "partner-password-0123";
let ipSeq = 0;

/** A request from a distinct client address unless one is given (sign-in limits are per address). */
async function call(method: "GET" | "POST", path: string, body?: unknown, opts: { cookie?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { origin: BASE, "x-forwarded-for": opts.ip ?? `198.51.100.${++ipSeq % 250}` };
  if (body) headers["content-type"] = "application/json";
  if (opts.cookie) headers.cookie = opts.cookie;
  return handleAuthRequest(coreAuth(), new Request(`${BASE}/api/auth${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }));
}

const signIn = (username: string, password: string, ip?: string) => call("POST", "/sign-in/username", { username, password }, { ip });

function sessionCookie(res: Response): string {
  const c = res.headers.getSetCookie().find((h) => h.startsWith("oryn.session_token="));
  if (!c) throw new Error("no session cookie");
  return c.split(";")[0]!;
}

async function sessionOf(cookie: string) {
  const res = await call("GET", "/get-session", undefined, { cookie });
  return (await res.json()) as { user: { id: string; username: string } } | null;
}

const access = (userId: string, slug: string) => resolveUserOrgAccess({ id: userId, label: "t", isPlatformAdmin: false }, slug, meta);

describe("administrator-provisioned accounts", () => {
  beforeEach(resetDb);
  afterAll(async () => {
    await closeAuthPool();
    await closeTestDb();
  });

  it("signs in with a username (case-insensitive) using the password the administrator provisioned", async () => {
    await createOrg("city-a", "municipal");
    const r = await createPartnerAccount(CLI, { username: "JDoe", name: "Jane Doe", orgSlug: "city-a", role: "viewer" }, { password: PASSWORD });
    expect(r).toMatchObject({ created: true, username: "jdoe", temporaryPassword: null, membership: "created" });

    const res = await signIn("jdoe", PASSWORD);
    expect(res.status).toBe(200);
    const s = await sessionOf(sessionCookie(res));
    expect(s?.user).toMatchObject({ id: r.userId, username: "jdoe" });
    expect((await signIn("JDOE", PASSWORD)).status).toBe(200);

    // Stored with a non-deliverable placeholder address, never marked verified.
    const [u] = await ownerSql()`select email, "emailVerified", "displayUsername" from auth_user where id = ${r.userId}`;
    expect(u).toMatchObject({ email: "jdoe@accounts.oryn.invalid", emailVerified: false, displayUsername: "JDoe" });
    // The password is stored only as Better Auth's scrypt hash.
    const [acct] = await ownerSql()`select password from auth_account where "userId" = ${r.userId} and "providerId" = 'credential'`;
    expect(acct!.password).not.toContain(PASSWORD);
    expect(acct!.password).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
  });

  it("answers an unknown username and a wrong password identically", async () => {
    await createPartnerAccount(CLI, { username: "jdoe", name: "Jane Doe" }, { password: PASSWORD });
    const wrong = await signIn("jdoe", "not-the-password-1");
    const unknown = await signIn("nobody_here", "not-the-password-1");
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
    expect(wrong.headers.getSetCookie().some((c) => c.startsWith("oryn.session_token=") && !c.includes("Max-Age=0"))).toBe(false);
  });

  it("refuses disabled accounts exactly like a wrong password, and ends their sessions and API keys", async () => {
    const org = await createOrg("city-a", "municipal");
    const r = await createPartnerAccount(CLI, { username: "jdoe", name: "Jane Doe", orgSlug: "city-a", role: "analyst", requirePasswordChange: false }, { password: PASSWORD });
    const cookie = sessionCookie(await signIn("jdoe", PASSWORD));
    expect(await sessionOf(cookie)).not.toBeNull();
    await ownerSql()`insert into api_keys (org_id, name, prefix, key_hash, scopes, created_by)
                     values (${org.id}, 'k', 'abcd1234', '\\x00'::bytea, '{results.read}', ${r.userId})`;

    const d = await setAccountDisabled(CLI, "jdoe", true, { reason: "contract ended" });
    expect(d).toEqual({ changed: true, sessionsRevoked: 1, apiKeysRevoked: 1 });
    expect(await sessionOf(cookie)).toBeNull();

    const disabled = await signIn("jdoe", PASSWORD);
    const wrong = await signIn("jdoe", "not-the-password-1");
    expect(disabled.status).toBe(401);
    expect(await disabled.json()).toEqual(await wrong.json());
    await expect(access(r.userId, "city-a")).rejects.toMatchObject({ status: 401 });
    expect(await listUserOrgs(r.userId)).toEqual([]);

    await setAccountDisabled(CLI, "jdoe", false);
    expect((await signIn("jdoe", PASSWORD)).status).toBe(200);
    const [key] = await ownerSql()`select revoked_at from api_keys where prefix = 'abcd1234'`;
    expect(key!.revoked_at).not.toBeNull(); // re-enabling does not resurrect revoked keys
  });

  it("a reset revokes sessions and requires a new password before any real organization opens", async () => {
    await createOrg("city-a", "municipal");
    const r = await createPartnerAccount(CLI, { username: "jdoe", name: "Jane Doe", orgSlug: "city-a", role: "viewer" }, { password: PASSWORD });
    // Newly provisioned: signed in, but the organization stays closed until the password is changed.
    const cookie = sessionCookie(await signIn("jdoe", PASSWORD));
    await expect(access(r.userId, "city-a")).rejects.toMatchObject({ code: "password_change_required", status: 403 });
    expect((await listUserOrgs(r.userId))[0]).toMatchObject({ slug: "city-a", passwordChangeRequired: true });

    const user = { id: r.userId, username: "jdoe", label: "jdoe", mustChangePassword: true };
    const deps = { auth: coreAuth(), headers: new Headers({ cookie }) };
    await expect(changeOwnPassword(user, { currentPassword: PASSWORD, newPassword: PASSWORD, confirm: PASSWORD }, meta, deps)).rejects.toThrow();
    await expect(
      changeOwnPassword(user, { currentPassword: "wrong-password-123", newPassword: "a-new-passphrase-42", confirm: "a-new-passphrase-42" }, meta, deps),
    ).rejects.toMatchObject({ fields: { currentPassword: "The current password is incorrect." } });
    await changeOwnPassword(user, { currentPassword: PASSWORD, newPassword: "a-new-passphrase-42", confirm: "a-new-passphrase-42" }, meta, deps);
    expect((await access(r.userId, "city-a")).org.slug).toBe("city-a");
    expect(await sessionOf(cookie)).toBeNull(); // changing the password ended the old session
    expect((await signIn("jdoe", PASSWORD)).status).toBe(401);
    const fresh = sessionCookie(await signIn("jdoe", "a-new-passphrase-42"));

    // Administrator reset: sessions end, a change is required again.
    const reset = await resetAccountPassword(CLI, "jdoe");
    expect(reset.sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect(reset.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(await sessionOf(fresh)).toBeNull();
    await expect(access(r.userId, "city-a")).rejects.toMatchObject({ code: "password_change_required" });
    expect((await signIn("jdoe", reset.temporaryPassword!)).status).toBe(200);

    const sessions = sessionCookie(await signIn("jdoe", reset.temporaryPassword!));
    expect((await revokeAccountSessions(CLI, "jdoe")).sessionsRevoked).toBe(2);
    expect(await sessionOf(sessions)).toBeNull();
  });

  it("confines a trial-only account to trial workspaces, in the database and in the access resolver", async () => {
    const real = await createOrg("city-a", "municipal");
    const trial = await ensureTrialOrganization(CLI, { slug: "oryn-trial" });
    expect(trial.created).toBe(true);
    const r = await createPartnerAccount(CLI, { username: "OrynTest", name: "ORYN Trial", orgSlug: "oryn-trial", role: "viewer", trialOnly: true }, { password: PASSWORD });

    // Trial data opens without a password change; it is synthetic by constraint.
    const a = await access(r.userId, "oryn-trial");
    expect(a.org).toMatchObject({ isTrial: true, isSynthetic: true });
    expect(a.can("aoi.write")).toBe(false);
    expect((await listUserOrgs(r.userId)).map((o) => o.slug)).toEqual(["oryn-trial"]);

    // A real organization cannot be joined: service, raw SQL (trigger), and conversion paths all refuse.
    await expect(setMembership(CLI, "oryntest", "city-a", "viewer")).rejects.toMatchObject({ code: "trial_restricted" });
    await expect(ownerSql()`insert into memberships (org_id, user_id, role) values (${real.id}, ${r.userId}, 'viewer')`).rejects.toMatchObject({ code: "OR001" });
    await expect(createPartnerAccount(CLI, { username: "trial2", name: "Trial Two", orgSlug: "city-a", trialOnly: true })).rejects.toMatchObject({ code: "trial_restricted" });
    await expect(ownerSql()`update organizations set is_trial = false where id = ${trial.id}`).rejects.toMatchObject({ code: "OR001" });
    await expect(ownerSql()`insert into platform_admins (user_id, granted_by) values (${r.userId}, 'test')`).rejects.toMatchObject({ code: "OR001" });
    await expect(ownerSql()`update organizations set is_trial = true where id = ${real.id}`).rejects.toMatchObject({ code: "23514" }); // only synthetic orgs
    await expect(access(r.userId, "city-a")).rejects.toMatchObject({ status: 404 });

    // Lifting the restriction forces a password change before real data.
    const partner = await createPartnerAccount(CLI, { username: "converted", name: "Converted", orgSlug: "oryn-trial", trialOnly: true, requirePasswordChange: false }, { password: PASSWORD });
    await setTrialOnly(CLI, "converted", false);
    await addMember(real.id, partner.userId, "viewer");
    await expect(access(partner.userId, "city-a")).rejects.toMatchObject({ code: "password_change_required" });
  });

  it("keeps partners inside their own organization", async () => {
    await createOrg("city-a", "municipal");
    await createOrg("farm-b", "agriculture");
    const r = await createPartnerAccount(CLI, { username: "jdoe", name: "Jane Doe", orgSlug: "city-a", role: "analyst", requirePasswordChange: false }, { password: PASSWORD });
    expect((await access(r.userId, "city-a")).role).toBe("analyst");
    await expect(access(r.userId, "farm-b")).rejects.toBeInstanceOf(AccessError);
    await expect(access(r.userId, "farm-b")).rejects.toMatchObject({ status: 404 });
    // Least privilege: role changes are explicit, and the last administrator cannot be removed.
    expect((await setMembership(CLI, "jdoe", "city-a", "viewer")).result).toBe("updated");
    expect((await access(r.userId, "city-a")).can("aoi.write")).toBe(false);
    await setMembership(CLI, "jdoe", "city-a", "org_admin");
    await expect(removeMembership(CLI, "jdoe", "city-a")).rejects.toMatchObject({ code: "last_admin" });
  });

  it("rejects public registration through every path", async () => {
    const body = { email: "intruder@example.com", password: "a-long-password-123", name: "Intruder", username: "intruder" };
    // 1. Not served by the ORYN route (allowlist).
    expect((await call("POST", "/sign-up/email", body)).status).toBe(404);
    // 2. Disabled in Better Auth even if the handler were mounted directly.
    const direct = await coreAuth().handler(new Request(`${BASE}/api/auth/sign-up/email`, { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect(direct.status).toBe(404);
    // 3. Refused by Better Auth itself for server-side calls.
    await expect(coreAuth().api.signUpEmail({ body })).rejects.toThrow(/not enabled/i);
    // 4. Refused by the database hook without a trusted provisioning flow.
    const ctx = await coreAuth().$context;
    await expect(ctx.internalAdapter.createUser({ email: "x@example.com", name: "X", emailVerified: false }, { method: "email-password" })).resolves.toBeNull();
    // A trusted flow must name the address it creates.
    await expect(
      trustedUserCreation.run({ reason: "test", email: "other@example.com" }, () => ctx.internalAdapter.createUser({ email: "x@example.com", name: "X", emailVerified: false }, { method: "email-password" })),
    ).resolves.toBeNull();
    const [n] = await ownerSql()<{ n: number }[]>`select count(*)::int as n from auth_user`;
    expect(n!.n).toBe(0);
    // Self-service account changes and username probing are not reachable either.
    for (const path of ["/is-username-available", "/update-user", "/change-password", "/delete-user", "/change-email", "/sign-in/social"]) {
      expect((await call("POST", path, { username: "x" })).status).toBe(404);
    }
  });

  it("rate-limits username sign-in per client address", async () => {
    await createPartnerAccount(CLI, { username: "jdoe", name: "Jane Doe" }, { password: PASSWORD });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await signIn("jdoe", "not-the-password-1", "192.0.2.77")).status);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
    // Even the right password is refused from that address until the window passes; other clients are unaffected.
    expect((await signIn("jdoe", PASSWORD, "192.0.2.77")).status).toBe(429);
    expect((await signIn("jdoe", PASSWORD, "192.0.2.78")).status).toBe(200);
  });

  it("behind a multi-hop proxy (Railway), ORYN_CLIENT_IP_HEADER keeps sign-in limits per client", async () => {
    await createPartnerAccount(CLI, { username: "jdoe", name: "Jane Doe" }, { password: PASSWORD });
    // Railway's edge: X-Forwarded-For is a chain (client, then a Railway hop); X-Real-IP is the client.
    const viaRailway = (auth: { handler: (r: Request) => Promise<Response> }, client: string, password = "not-the-password-1") =>
      handleAuthRequest(auth, new Request(`${BASE}/api/auth/sign-in/username`, {
        method: "POST",
        headers: { origin: BASE, "content-type": "application/json", "x-forwarded-for": `${client}, 100.64.0.7`, "x-real-ip": client },
        body: JSON.stringify({ username: "jdoe", password }),
      }));
    try {
      // Without the setting the chain is not trusted: every client shares one bucket.
      const shared = betterAuth(buildAuthOptions());
      for (let i = 0; i < 5; i++) expect((await viaRailway(shared, "203.0.113.10")).status).toBe(401);
      expect((await viaRailway(shared, "203.0.113.99", PASSWORD)).status).toBe(429);
      await ownerSql()`delete from auth_rate_limit`;

      vi.stubEnv("ORYN_CLIENT_IP_HEADER", "X-Real-IP");
      const perClient = betterAuth(buildAuthOptions());
      for (let i = 0; i < 5; i++) expect((await viaRailway(perClient, "203.0.113.10")).status).toBe(401);
      expect((await viaRailway(perClient, "203.0.113.10")).status).toBe(429);
      expect((await viaRailway(perClient, "203.0.113.11", PASSWORD)).status).toBe(200);
      const keys = await ownerSql()<{ key: string }[]>`select key from auth_rate_limit order by key`;
      expect(keys.map((k) => k.key.split("|")[0])).toEqual(["203.0.113.10", "203.0.113.11"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("provisioning is idempotent and never resets an existing password", async () => {
    await createOrg("city-a", "municipal");
    await createOrg("farm-b", "agriculture");
    const first = await createPartnerAccount(CLI, { username: "jdoe", name: "Jane Doe", orgSlug: "city-a", role: "viewer" }, { password: PASSWORD });
    const [before] = await ownerSql()`select password from auth_account where "userId" = ${first.userId}`;
    const again = await createPartnerAccount(CLI, { username: "JDOE", name: "Someone Else", orgSlug: "city-a", role: "analyst" }, { password: "another-password-999" });
    expect(again).toMatchObject({ userId: first.userId, created: false, membership: "existing", temporaryPassword: null });
    expect(again.notes.join(" ")).toMatch(/Kept the existing viewer role/);
    const [after] = await ownerSql()`select password from auth_account where "userId" = ${first.userId}`;
    expect(after!.password).toBe(before!.password);
    // A rerun can add a missing membership.
    expect((await createPartnerAccount(CLI, { username: "jdoe", name: "Jane Doe", orgSlug: "farm-b" })).membership).toBe("created");
    const [counts] = await ownerSql()<{ users: number; members: number }[]>`
      select (select count(*)::int from auth_user) as users, (select count(*)::int from memberships) as members`;
    expect(counts).toEqual({ users: 1, members: 2 });
    expect(await accountExists(CLI, "JDoe")).toBe(true);
    // Generated passwords are returned once and work.
    const gen = await createPartnerAccount(CLI, { username: "generated", name: "Generated" });
    expect(gen.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect((await signIn("generated", gen.temporaryPassword!)).status).toBe(200);
  });

  it("only platform administrators manage accounts, and partner accounts never become platform administrators", async () => {
    const notAdmin: AccountOperator = { type: "platform_admin", userId: "u1", label: "x", isPlatformAdmin: false, mustChangePassword: false };
    const pendingAdmin: AccountOperator = { type: "platform_admin", userId: "u1", label: "x", isPlatformAdmin: true, mustChangePassword: true };
    for (const op of [notAdmin, pendingAdmin]) {
      await expect(createPartnerAccount(op, { username: "jdoe", name: "Jane Doe" })).rejects.toMatchObject({ status: 403 });
      await expect(resetAccountPassword(op, "jdoe")).rejects.toMatchObject({ status: 403 });
      await expect(setAccountDisabled(op, "jdoe", true)).rejects.toMatchObject({ status: 403 });
    }
    const r = await createPartnerAccount(CLI, { username: "jdoe", name: "Jane Doe" }, { password: PASSWORD });
    const [admin] = await ownerSql()`select 1 from platform_admins where user_id = ${r.userId}`;
    expect(admin).toBeUndefined();
    // A platform admin cannot lock themselves out.
    const me = await createUser("ops@example.com");
    const self: AccountOperator = { type: "platform_admin", userId: me.id, label: "ops", isPlatformAdmin: true, mustChangePassword: false };
    await expect(setAccountDisabled(self, "ops@example.com", true)).rejects.toMatchObject({ code: "invalid" });
  });

  it("audits account creation, role changes, resets, and deactivation without recording secrets", async () => {
    const org = await createOrg("city-a", "municipal");
    const r = await createPartnerAccount(CLI, { username: "jdoe", name: "Jane Doe", orgSlug: "city-a", role: "viewer" }, { password: PASSWORD });
    await setMembership(CLI, "jdoe", "city-a", "analyst");
    const reset = await resetAccountPassword(CLI, "jdoe");
    await setAccountDisabled(CLI, "jdoe", true, { reason: "left the project" });

    const platform = await ownerSql()<{ action: string; actor_label: string; metadata: Record<string, unknown> }[]>`
      select action, actor_label, metadata from audit_events where org_id is null and target_id = ${r.userId} order by id`;
    expect(platform.map((e) => e.action)).toEqual(["account.create", "account.membership_set", "account.password_reset", "account.disable"]);
    expect(platform.every((e) => e.actor_label === "cli:test")).toBe(true);
    expect(platform[0]!.metadata).toMatchObject({ account: "jdoe", org: "city-a", role: "viewer", must_change_password: true, password_source: "provided" });
    expect(platform[3]!.metadata).toMatchObject({ reason: "left the project" });

    const orgTrail = await ownerSql()<{ action: string }[]>`select action from audit_events where org_id = ${org.id} order by id`;
    expect(orgTrail.map((e) => e.action)).toEqual(["account.create", "member.add", "member.update", "account.password_reset", "account.disable"]);

    const everything = JSON.stringify(await ownerSql()`select * from audit_events`);
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain(reset.temporaryPassword!);
  });
});
