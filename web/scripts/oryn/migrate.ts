/**
 * Database migrations (schema owner only).
 *
 *   npm run db:migrate                 apply pending migrations
 *   npm run db:migrate -- --status     list applied / pending / modified; change nothing
 *   npm run db:migrate -- --check      like --status, but exit 3 when anything is pending
 *                                      (CI and deploy gates)
 *
 * Uses DATABASE_OWNER_URL. Forward-only: there are no down migrations — see
 * docs/DEPLOYMENT.md for the rollback procedure (restore, or roll forward).
 */
import { loadEnvConfig } from "@next/env";
import { postgresTlsOptions } from "@/server/db/tls";

async function main() {
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
  const [{ runMigrations, planMigrations }, { checkConfiguration, reportIssues }, { default: postgres }] = await Promise.all([
    import("@/server/db/migrate"),
    import("@/server/config/preflight"),
    import("postgres"),
  ]);
  if (reportIssues(checkConfiguration("migrate"), "migrate") > 0) process.exit(1);
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) throw new Error("DATABASE_OWNER_URL is not set.");

  if (process.argv.includes("--status") || process.argv.includes("--check")) {
    const sql = postgres(url, { ...postgresTlsOptions(url), max: 1, onnotice: () => {} });
    try {
      const plan = await planMigrations(sql);
      console.log(JSON.stringify(plan, null, 2));
      if (plan.modified.length || plan.unknown.length) process.exitCode = 4;
      else if (process.argv.includes("--check") && plan.pending.length) process.exitCode = 3;
    } finally {
      await sql.end({ timeout: 5 });
    }
    return;
  }

  const { applied, skipped } = await runMigrations(url, undefined, { log: (l) => console.log(l) });
  console.log(`migrations: ${applied.length} applied, ${skipped.length} already applied`);
  for (const f of applied) console.log(`  + ${f}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
