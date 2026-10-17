/**
 * Prints the SQL Better Auth needs for the configured options, against the
 * current database. Used to author db/migrations/*_auth.sql when upgrading
 * Better Auth or enabling an auth plugin. Does not modify the database.
 *
 *   npx tsx scripts/oryn/print-auth-schema.ts
 */
import { loadEnvConfig } from "@next/env";

async function main() {
  loadEnvConfig(process.cwd());
  const { getMigrations } = await import("better-auth/db/migration");
  const { buildAuthOptions, closeAuthPool } = await import("@/server/auth/options");
  const m = await getMigrations(buildAuthOptions());
  console.log(await m.compileMigrations());
  await closeAuthPool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
