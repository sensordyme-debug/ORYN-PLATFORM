/**
 * Readiness checks shared by the web service (/api/health/ready) and the
 * worker (/readyz). Each check proves the dependency works rather than that
 * it is configured: a query on the application role, the migration ledger
 * compared with this release, and a real write/read/delete in object storage.
 *
 * Responses carry only check names and states; failures are logged with
 * details server-side and never returned to the client.
 */
import { env } from "@/server/config/env";
import { db } from "@/server/db/client";
import { planMigrations } from "@/server/db/migrate";
import { log } from "@/server/log";
import { probeStorage } from "@/server/storage";

export type CheckState = "ok" | "fail" | "pending";
export type Readiness = {
  ready: boolean;
  mode: "platform" | "website_only";
  checks: { database?: CheckState; migrations?: CheckState; storage?: CheckState };
  /** Informational: the newest worker heartbeat (a web replica is ready without one). */
  worker?: { lastSeenSecondsAgo: number | null; live: number };
};

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms))]);
}

async function check(name: string, fn: () => Promise<CheckState>): Promise<CheckState> {
  try {
    return await fn();
  } catch (err) {
    log.error("readiness.check_failed", { check: name, err });
    return "fail";
  }
}

export async function readiness(opts: { storage?: boolean } = {}): Promise<Readiness> {
  if (!env.databaseConfigured()) return { ready: true, mode: "website_only", checks: {} };
  const database = await check("database", async () => {
    await withTimeout(db()`select 1`, 3_000, "database query");
    return "ok";
  });
  const migrations =
    database !== "ok"
      ? "fail"
      : await check("migrations", async () => {
          const plan = await withTimeout(planMigrations(db()), 5_000, "migration ledger");
          if (plan.modified.length) throw new Error(`modified migrations: ${plan.modified.join(", ")}`);
          return plan.pending.length ? "pending" : "ok";
        });
  const storage = opts.storage === false ? undefined : await check("storage", async () => ((await withTimeout(probeStorage(), 10_000, "storage probe")) ? "ok" : "fail"));
  let worker: Readiness["worker"];
  if (database === "ok") {
    worker = await db()<{ ago: number | null; live: number }[]>`
      select extract(epoch from now() - max(last_seen_at))::int as ago,
             count(*) filter (where last_seen_at > now() - interval '2 minutes')::int as live
        from worker_heartbeats`
      .then(([r]) => ({ lastSeenSecondsAgo: r?.ago ?? null, live: r?.live ?? 0 }))
      .catch(() => undefined);
  }
  const ready = database === "ok" && migrations === "ok" && (storage === undefined || storage === "ok");
  return { ready, mode: "platform", checks: { database, migrations, ...(storage ? { storage } : {}) }, ...(worker ? { worker } : {}) };
}
