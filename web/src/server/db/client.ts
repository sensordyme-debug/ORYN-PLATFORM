/**
 * PostgreSQL access.
 *
 * The application connects as `oryn_app` — a role without BYPASSRLS — so the
 * row-level security policies in db/migrations apply to every query. Each
 * unit of work runs in a transaction with an explicit context:
 *
 *   withTenant({ orgId, userId }, tx => …)   tenant-owned data for one org
 *   withUser(userId, tx => …)                the user's own memberships only
 *   withSystem(reason, tx => …)              cross-tenant platform operations
 *                                            (scheduler, AOI matching, platform
 *                                            admin). Every call site is a
 *                                            deliberate, reviewable exception.
 *
 * Queries are written with postgres.js tagged templates; interpolated values
 * are always sent as bind parameters, never concatenated into SQL text.
 */
import postgres from "postgres";
import { env } from "@/server/config/env";
import { postgresTlsOptions } from "@/server/db/tls";
import { log } from "@/server/log";

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

type GlobalWithDb = typeof globalThis & { __orynSql?: Sql };
const g = globalThis as GlobalWithDb;

/** Shared pool for the application role. Reused across hot reloads in development. */
export function db(): Sql {
  if (!g.__orynSql) {
    const url = env.databaseUrl();
    g.__orynSql = postgres(url, {
      ...postgresTlsOptions(url),
      max: env.dbPoolMax(),
      idle_timeout: 30,
      connect_timeout: 10,
      max_lifetime: 60 * 30,
      prepare: true,
      onnotice: () => {},
      connection: { application_name: "oryn-app" },
      transform: { undefined: null },
    });
  }
  return g.__orynSql;
}

/** Close the pool (CLI scripts and tests). */
export async function closeDb() {
  if (g.__orynSql) {
    await g.__orynSql.end({ timeout: 5 });
    g.__orynSql = undefined;
  }
}

export type TenantContext = { orgId: string; userId?: string | null };

export async function withTenant<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!ctx.orgId) throw new Error("withTenant requires an orgId");
  const result = await db().begin(async (tx) => {
    await tx`select set_config('app.org_id', ${ctx.orgId}, true), set_config('app.user_id', ${ctx.userId ?? ""}, true)`;
    return fn(tx);
  });
  return result as T;
}

export async function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const result = await db().begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return fn(tx);
  });
  return result as T;
}

/**
 * Cross-tenant access. `reason` is logged at debug level so system-context
 * usage can be traced; keep call sites few and grep-able.
 */
export async function withSystem<T>(reason: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  log.debug("db.system_context", { reason });
  const result = await db().begin(async (tx) => {
    await tx`select set_config('app.system', 'on', true)`;
    return fn(tx);
  });
  return result as T;
}

/**
 * A value for a `${…}::jsonb` parameter. postgres.js serializes parameters
 * whose server-inferred type is json/jsonb itself, so the value must be passed
 * as-is — pre-stringifying would store a JSON *string* instead of an object.
 * Undefined values inside objects are dropped (JSON semantics).
 */
export function jsonb(value: unknown): postgres.Parameter {
  const plain = value === undefined ? null : (JSON.parse(JSON.stringify(value)) as postgres.JSONValue);
  return db().json(plain);
}
