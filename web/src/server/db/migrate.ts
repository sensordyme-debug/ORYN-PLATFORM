/**
 * Forward-only SQL migration runner.
 *
 * - Migrations live in db/migrations as NNNN_name.sql and run in name order.
 * - Each runs in its own transaction as the schema owner, with a lock timeout
 *   (a migration waiting on a busy table fails fast instead of queueing every
 *   application query behind it) and a statement timeout.
 * - Applied migrations are recorded with a SHA-256 checksum; editing an
 *   applied migration is an error (write a new migration instead).
 * - A session advisory lock prevents concurrent runners (two deploys, or a
 *   deploy and an operator, cannot interleave).
 * - It refuses to run as the least-privilege application role.
 * - planMigrations() reports applied / pending / modified without changing
 *   anything (`npm run db:migrate -- --status`, and the readiness check).
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { postgresTlsOptions } from "@/server/db/tls";

export type MigrationResult = { applied: string[]; skipped: string[] };
export type MigrationPlan = { applied: string[]; pending: string[]; modified: string[]; unknown: string[] };

const LOCK_KEY = 784_120_331; // arbitrary, stable

export function migrationsDir(): string {
  // Runtime data (the deployed image ships db/migrations) — excluded from build tracing.
  return path.join(/* turbopackIgnore: true */ process.cwd(), "db", "migrations");
}

async function migrationFiles(dir: string): Promise<{ file: string; body: string; checksum: string }[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[\w-]+\.sql$/.test(f)).sort();
  return Promise.all(
    files.map(async (file) => {
      const body = await readFile(path.join(dir, file), "utf8");
      return { file, body, checksum: createHash("sha256").update(body).digest("hex") };
    }),
  );
}

/** Compare migration files with the database ledger. Read-only. */
export async function planMigrations(sql: postgres.Sql, dir = migrationsDir()): Promise<MigrationPlan> {
  const files = await migrationFiles(dir);
  const [exists] = await sql<{ ok: boolean }[]>`select to_regclass('public.schema_migrations') is not null as ok`;
  const done = exists?.ok
    ? new Map((await sql<{ version: string; checksum: string }[]>`select version, checksum from schema_migrations`).map((r) => [r.version, r.checksum]))
    : new Map<string, string>();
  const known = new Set(files.map((f) => f.file));
  return {
    applied: files.filter((f) => done.get(f.file) === f.checksum).map((f) => f.file),
    pending: files.filter((f) => !done.has(f.file)).map((f) => f.file),
    modified: files.filter((f) => done.has(f.file) && done.get(f.file) !== f.checksum).map((f) => f.file),
    // In the database but not in this release: the database is newer than the code (rollback hazard).
    unknown: [...done.keys()].filter((v) => !known.has(v)).sort(),
  };
}

export async function runMigrations(
  connectionString: string,
  dir = migrationsDir(),
  opts: { lockTimeout?: string; statementTimeout?: string; log?: (line: string) => void } = {},
): Promise<MigrationResult> {
  const sql = postgres(connectionString, { ...postgresTlsOptions(connectionString), max: 1, onnotice: () => {}, connection: { application_name: "oryn-migrate" } });
  const applied: string[] = [];
  const skipped: string[] = [];
  const say = opts.log ?? (() => {});
  try {
    // pg_has_role() is true for superusers on every role, so exclude them
    // (a superuser owner is common in development and some installs).
    const [who] = await sql<{ is_app: boolean; usr: string }[]>`
      select current_user as usr,
             exists (select 1 from pg_roles where rolname = 'oryn_app_role')
               and not (select rolsuper from pg_roles where rolname = current_user)
               and pg_has_role(current_user, 'oryn_app_role', 'member') as is_app`;
    if (who?.is_app) {
      throw new Error(`Refusing to migrate as "${who.usr}", a member of oryn_app_role. Run migrations with the schema owner (DATABASE_OWNER_URL).`);
    }
    await sql`select pg_advisory_lock(${LOCK_KEY})`;
    await sql`
      create table if not exists schema_migrations (
        version text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )`;
    const plan = await planMigrations(sql, dir);
    if (plan.modified.length) {
      throw new Error(`Migration ${plan.modified[0]} was modified after it was applied (checksum mismatch). Create a new migration instead.`);
    }
    skipped.push(...plan.applied);
    const files = await migrationFiles(dir);
    for (const m of files.filter((f) => plan.pending.includes(f.file))) {
      const started = Date.now();
      await sql.begin(async (tx) => {
        await tx`select set_config('lock_timeout', ${opts.lockTimeout ?? "15s"}, true), set_config('statement_timeout', ${opts.statementTimeout ?? "15min"}, true)`;
        await tx.unsafe(m.body);
        await tx`insert into schema_migrations (version, checksum) values (${m.file}, ${m.checksum})`;
      });
      applied.push(m.file);
      say(JSON.stringify({ t: new Date().toISOString(), level: "info", msg: "migration.applied", version: m.file, ms: Date.now() - started }));
    }
    return { applied, skipped };
  } finally {
    await sql`select pg_advisory_unlock(${LOCK_KEY})`.catch(() => {});
    await sql.end({ timeout: 5 });
  }
}
