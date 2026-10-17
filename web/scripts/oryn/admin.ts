/**
 * Platform administrator management (run by an operator with database
 * owner credentials — there is no web bootstrap route).
 *
 *   npm run oryn:admin -- create --email ops@example.com --name "Ops Lead" [--username ops.lead]
 *       Creates the account (password from ORYN_ADMIN_PASSWORD, or a random
 *       one printed once), grants platform administration, and requires a
 *       password change at first sign-in (the password is operator-issued).
 *       Partner and trial accounts are managed with `npm run oryn:accounts`.
 *   npm run oryn:admin -- grant  --email person@example.com
 *   npm run oryn:admin -- revoke --email person@example.com
 *   npm run oryn:admin -- list
 */
import { randomBytes } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { postgresTlsOptions } from "@/server/db/tls";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  loadEnvConfig(process.cwd());
  const [{ default: postgres }, opts, accounts, db] = await Promise.all([
    import("postgres"),
    import("@/server/auth/options"),
    import("@/server/accounts/service"),
    import("@/server/db/client"),
  ]);
  const ownerUrl = process.env.DATABASE_OWNER_URL;
  if (!ownerUrl) throw new Error("DATABASE_OWNER_URL is required.");
  const owner = postgres(ownerUrl, { ...postgresTlsOptions(ownerUrl), max: 1, onnotice: () => {} });
  const cmd = process.argv[2];
  const email = arg("email")?.toLowerCase();
  try {
    if (cmd === "list") {
      const rows = await owner`select u.email, u.name, p.granted_at, p.granted_by from platform_admins p join auth_user u on u.id = p.user_id order by p.granted_at`;
      console.table(rows);
      return;
    }
    if (!email) throw new Error("--email is required");

    if (cmd === "create") {
      const name = arg("name") ?? email.split("@")[0]!;
      const password = process.env.ORYN_ADMIN_PASSWORD ?? randomBytes(18).toString("base64url");
      // The operator vouches for the address of the administrator they create.
      await accounts.createCredentialUser({ email, name, password, username: arg("username") ?? null, emailVerified: true }, "admin_cli");
      console.log(`Created ${email}.`);
      if (!process.env.ORYN_ADMIN_PASSWORD) console.log(`Temporary password (shown once): ${password}`);
    } else if (cmd !== "grant" && cmd !== "revoke") {
      throw new Error(`Unknown command "${cmd}". Use create | grant | revoke | list.`);
    }

    const [user] = await owner<{ id: string }[]>`select id from auth_user where lower(email) = ${email}`;
    if (!user) throw new Error(`No account for ${email}.`);
    if (cmd === "create") {
      // The operator chose or saw this password, so it is temporary: the owner
      // must replace it before opening any organization (as for partner accounts).
      await owner`
        insert into account_controls (user_id, must_change_password) values (${user.id}, true)
        on conflict (user_id) do update set must_change_password = true`;
      console.log("A password change is required at first sign-in.");
    }
    const operator = process.env.USER ?? "cli";
    if (cmd === "revoke") {
      await owner`delete from platform_admins where user_id = ${user.id}`;
      await owner`insert into audit_events (org_id, actor_type, actor_label, action, target_type, target_id) values (null, 'system', ${`cli:${operator}`}, 'platform.admin_revoke', 'user', ${user.id})`;
      console.log(`Revoked platform administration from ${email}.`);
    } else {
      await owner`insert into platform_admins (user_id, granted_by) values (${user.id}, ${`cli:${operator}`}) on conflict do nothing`;
      await owner`insert into audit_events (org_id, actor_type, actor_label, action, target_type, target_id) values (null, 'system', ${`cli:${operator}`}, 'platform.admin_grant', 'user', ${user.id})`;
      console.log(`Granted platform administration to ${email}.`);
    }
  } finally {
    await owner.end({ timeout: 5 });
    await opts.closeAuthPool();
    await db.closeDb();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
