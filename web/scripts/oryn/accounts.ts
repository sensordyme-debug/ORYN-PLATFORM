/**
 * Partner and trial account administration for operators (database owner
 * environment; uses the same audited service as the platform admin UI).
 *
 * Passwords are never taken from command-line arguments (they would land in
 * shell history and process listings). Each command that sets a password reads
 * it from ORYN_PROVISION_PASSWORD, or prompts without echo, or generates one
 * with --generate-password and prints it once. Provided passwords are never
 * printed or logged.
 *
 *   npm run oryn:accounts -- provision-trial [--username OrynTest] [--org oryn-trial] [--demo-areas]
 *       Trial workspace (synthetic, created if missing) + a trial-only viewer
 *       account confined to it. Idempotent: an existing account keeps its password.
 *   npm run oryn:accounts -- create --username jdoe --name "Jane Doe" --org tarboro-nc --role viewer [--email jane@example.org]
 *       Partner account; must change its password at first sign-in. Idempotent.
 *   npm run oryn:accounts -- reset-password --user jdoe          new password, sessions revoked, change required
 *   npm run oryn:accounts -- disable --user jdoe [--reason "…"]   sessions and the API keys it created are revoked
 *   npm run oryn:accounts -- enable --user jdoe
 *   npm run oryn:accounts -- revoke-sessions --user jdoe
 *   npm run oryn:accounts -- set-role --user jdoe --org tarboro-nc --role analyst
 *   npm run oryn:accounts -- remove-member --user jdoe --org tarboro-nc
 *   npm run oryn:accounts -- trial-only --user jdoe --off         (lifting it forces a password change)
 *   npm run oryn:accounts -- set-username --user person@example.org --username person
 *   npm run oryn:accounts -- list
 *
 * --user accepts a username or an email address.
 */
import { userInfo } from "node:os";
import { loadEnvConfig } from "@next/env";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name: string) => argv.includes(`--${name}`);
function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}
function need(name: string): string {
  const v = opt(name);
  if (!v) throw new Error(`--${name} is required.`);
  return v;
}

function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return Promise.reject(new Error("No terminal to prompt for a password. Set ORYN_PROVISION_PASSWORD or pass --generate-password."));
  }
  process.stdout.write(question);
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (fn: () => void) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      fn();
    };
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") return done(() => resolve(value));
        if (c === "\u0003") return done(() => reject(new Error("Cancelled.")));
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  });
}

/** undefined → let the service generate one (printed once by the caller). */
async function passwordInput(passwordSchema: { parse(v: unknown): string }): Promise<string | undefined> {
  if (flag("generate-password")) return undefined;
  const fromEnv = process.env.ORYN_PROVISION_PASSWORD;
  if (fromEnv) return passwordSchema.parse(fromEnv);
  const first = await promptHidden("New password (12–128 characters, not echoed): ");
  const second = await promptHidden("Repeat it: ");
  if (first !== second) throw new Error("The passwords do not match.");
  return passwordSchema.parse(first);
}

async function main() {
  loadEnvConfig(process.cwd());
  const [accounts, authOpts, access, aois, db] = await Promise.all([
    import("@/server/accounts/service"),
    import("@/server/auth/options"),
    import("@/server/authz/access"),
    import("@/server/aois/service"),
    import("@/server/db/client"),
  ]);
  const op = { type: "cli", label: `cli:${process.env.USER ?? userInfo().username}` } as const;
  const say = (line: string) => console.log(line);
  const printSecret = (pw: string | null) => {
    if (pw) say(`Temporary password (shown once — deliver it out of band; it must be changed at first sign-in): ${pw}`);
  };

  try {
    switch (cmd) {
      case "list": {
        const rows = await accounts.listAccounts(op);
        console.table(
          rows.map((a) => ({
            username: a.displayUsername ?? "",
            email: a.email ?? "",
            name: a.name,
            status: a.disabledAt ? "disabled" : "active",
            flags: [a.mustChangePassword && "must-change-password", a.trialOnly && "trial-only", a.isPlatformAdmin && "platform-admin"].filter(Boolean).join(","),
            orgs: a.memberships.map((m) => `${m.slug}:${m.role}`).join(" "),
            sessions: a.activeSessions,
          })),
        );
        break;
      }

      case "create":
      case "provision-trial": {
        const trial = cmd === "provision-trial";
        if (trial && process.env.NODE_ENV === "production" && !flag("allow-production")) {
          throw new Error("A shared trial account in production needs --allow-production (it can only reach trial workspaces, but its password is shared).");
        }
        const username = trial ? (opt("username") ?? "OrynTest") : need("username");
        let orgSlug = opt("org") ?? null;
        if (trial) {
          const org = await accounts.ensureTrialOrganization(
            op,
            { slug: orgSlug ?? "oryn-trial", name: opt("org-name") ?? "ORYN Trial Workspace", kind: (opt("kind") ?? "agriculture") as "agriculture" },
            { convertSynthetic: flag("convert-synthetic") },
          );
          orgSlug = org.slug;
          say(`Trial workspace ${org.slug}: ${org.created ? "created" : "already exists"} (synthetic sample data only).`);
          if (flag("demo-areas")) await createDemoAreas(org.slug);
        }
        const existing = await accounts.accountExists(op, username);
        const password = existing ? undefined : await passwordInput(accounts.passwordSchema);
        const result = await accounts.createPartnerAccount(
          op,
          {
            username,
            name: opt("name") ?? (trial ? "ORYN Trial" : username),
            email: opt("email") ?? null,
            orgSlug,
            role: (opt("role") ?? "viewer") as "viewer",
            trialOnly: trial || flag("trial-only"),
            requirePasswordChange: !flag("no-require-change"),
          },
          { password: existing ? null : (password ?? null) },
        );
        say(result.created ? `Created ${result.username}${orgSlug ? ` (${opt("role") ?? "viewer"} in ${orgSlug})` : ""}.` : `${result.username} already exists.`);
        if (result.membership === "created" && !result.created) say(`Added membership in ${orgSlug}.`);
        for (const n of result.notes) say(n);
        printSecret(result.temporaryPassword);
        break;
      }

      case "reset-password": {
        const user = need("user");
        const password = await passwordInput(accounts.passwordSchema);
        const r = await accounts.resetAccountPassword(op, user, { password: password ?? null, requireChange: !flag("no-require-change") });
        say(`Password reset for ${user}; ${r.sessionsRevoked} session(s) revoked${flag("no-require-change") ? "" : "; it must be changed at next sign-in"}.`);
        printSecret(r.temporaryPassword);
        break;
      }

      case "disable":
      case "enable": {
        const user = need("user");
        const r = await accounts.setAccountDisabled(op, user, cmd === "disable", { reason: opt("reason") ?? null });
        if (!r.changed) say(`${user} is already ${cmd}d.`);
        else if (cmd === "disable") say(`Disabled ${user}; ${r.sessionsRevoked} session(s) and ${r.apiKeysRevoked} API key(s) revoked.`);
        else say(`Enabled ${user}.`);
        break;
      }

      case "revoke-sessions": {
        const r = await accounts.revokeAccountSessions(op, need("user"));
        say(`${r.sessionsRevoked} session(s) revoked.`);
        break;
      }

      case "set-role": {
        const r = await accounts.setMembership(op, need("user"), need("org"), need("role") as "viewer");
        say(`Membership ${r.result}.`);
        break;
      }

      case "remove-member": {
        await accounts.removeMembership(op, need("user"), need("org"));
        say("Membership removed.");
        break;
      }

      case "trial-only": {
        if (flag("on") === flag("off")) throw new Error("Pass exactly one of --on or --off.");
        const r = await accounts.setTrialOnly(op, need("user"), flag("on"));
        say(flag("on") ? "Account confined to trial workspaces." : `Trial restriction lifted; password change required; ${r.sessionsRevoked} session(s) revoked.`);
        break;
      }

      case "set-username": {
        await accounts.setUsername(op, need("user"), need("username"));
        say("Username set.");
        break;
      }

      default:
        throw new Error(`Unknown command "${cmd ?? ""}". See the header of scripts/oryn/accounts.ts for usage.`);
    }
  } finally {
    await authOpts.closeAuthPool();
    await db.closeDb();
  }

  /** Synthetic sample fields for a trial workspace (only when it has no areas yet). */
  async function createDemoAreas(slug: string) {
    const a = await access.operatorOrgAccess(slug, op.label);
    const count = await a.tx(async (tx) => (await tx<{ n: number }[]>`select count(*)::int as n from aois where org_id = ${a.org.id}`)[0]!.n);
    if (count > 0) return say(`Trial workspace already has ${count} area(s); none added.`);
    const box = ([w, s, e, n]: [number, number, number, number]) => ({ type: "Polygon" as const, coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] as [number, number][][] });
    const note = "Synthetic trial boundary placed on land classified as cropland in ESA WorldCover 2021 (Edgecombe County, NC). Not a real customer field.";
    const source = { method: "synthetic" as const, note, retrieved_at: new Date().toISOString() };
    const fields: [string, [number, number, number, number], string][] = [
      ["Trial field A (synthetic)", [-77.45, 35.84, -77.4455, 35.8436], "cotton"],
      ["Trial field B (synthetic)", [-77.45, 35.86, -77.4455, 35.8636], "soybeans"],
      ["Trial field C (synthetic)", [-77.47, 35.92, -77.4655, 35.9236], "peanuts"],
    ];
    for (const [name, b, crop] of fields) {
      await aois.createAoi(a, { name, kind: "field", geometry: box(b), metadata: { crop, season: "2026", trial: true } }, { boundarySource: source, isSynthetic: true });
    }
    say(`Created ${fields.length} synthetic trial fields; the worker fetches public imagery for them.`);
  }
}

main().catch((err) => {
  const e = err as { message?: string; fields?: Record<string, string>; issues?: { message: string }[] };
  console.error(e.fields ? Object.values(e.fields).join(" ") : e.issues ? e.issues.map((i) => i.message).join(" ") : (e.message ?? String(err)));
  process.exit(1);
});
