/**
 * Production operations: readiness checks, migration planning and safety,
 * database-role preflight, the cron endpoint's authentication, worker
 * heartbeats, and retry timing for provider errors.
 */
import { copyFileSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as cronTick } from "@/app/api/cron/tick/route";
import { GET as healthLive } from "@/app/api/health/route";
import { GET as healthReady } from "@/app/api/health/ready/route";
import { checkDatabase } from "@/server/config/preflight";
import { migrationsDir, planMigrations, runMigrations } from "@/server/db/migrate";
import { readiness } from "@/server/health";
import { recordWorkerHeartbeat, removeWorkerHeartbeat } from "@/server/jobs/heartbeat";
import { claimJobs, enqueue } from "@/server/jobs/queue";
import { executeJob, type HandlerRegistry, type WorkerStatus } from "@/server/jobs/worker";
import { ProviderError, setProviderFetch } from "@/server/providers/http";
import { closeTestDb, createOrg, ownerSql, resetDb } from "../helpers/db";
import { testDatabaseUrls } from "../helpers/test-env";

const urls = testDatabaseUrls();
const sqlFor = (url: string) => postgres(url, { max: 1, onnotice: () => {} });

describe("operations", () => {
  beforeEach(resetDb);
  afterEach(() => vi.unstubAllEnvs());
  afterAll(closeTestDb);

  it("is ready when the database, migrations, and storage work, and reports worker liveness", async () => {
    const before = await readiness();
    expect(before).toMatchObject({ ready: true, mode: "platform", checks: { database: "ok", migrations: "ok", storage: "ok" }, worker: { live: 0 } });

    const status: WorkerStatus = { workerId: "w-test", startedAt: Date.now(), lastLoopAt: Date.now(), lastDbOkAt: Date.now(), inFlight: 1, stopping: false };
    await recordWorkerHeartbeat(status, { scheduler: true, concurrency: 2, version: "test" });
    expect((await readiness()).worker).toMatchObject({ live: 1, lastSeenSecondsAgo: expect.any(Number) });
    await removeWorkerHeartbeat("w-test");
    expect((await readiness()).worker?.live).toBe(0);

    const live = await healthLive();
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ status: "ok", service: "web" });
    const ready = await healthReady();
    expect(ready.status).toBe(200);
    const body = await ready.json();
    expect(body).toMatchObject({ status: "ready", checks: { database: "ok", migrations: "ok", storage: "ok" } });
    // Only states — no connection strings, hosts, or error text.
    expect(JSON.stringify(body)).not.toMatch(/postgres:|password|oryn_app/);
  });

  it("plans migrations without changing anything: pending, modified, and newer-than-code", async () => {
    const sql = sqlFor(urls.owner);
    try {
      expect(await planMigrations(sql)).toMatchObject({ pending: [], modified: [], unknown: [] });
      const files = readdirSync(migrationsDir()).filter((f) => f.endsWith(".sql")).sort();

      const ahead = mkdtempSync(path.join(tmpdir(), "oryn-mig-"));
      for (const f of files) copyFileSync(path.join(migrationsDir(), f), path.join(ahead, f));
      writeFileSync(path.join(ahead, "9999_future.sql"), "select 1;");
      expect((await planMigrations(sql, ahead)).pending).toEqual(["9999_future.sql"]);

      const edited = mkdtempSync(path.join(tmpdir(), "oryn-mig-"));
      for (const f of files) copyFileSync(path.join(migrationsDir(), f), path.join(edited, f));
      writeFileSync(path.join(edited, files[0]!), "-- edited after being applied\n");
      expect((await planMigrations(sql, edited)).modified).toEqual([files[0]]);

      const behind = mkdtempSync(path.join(tmpdir(), "oryn-mig-"));
      for (const f of files.slice(0, -1)) copyFileSync(path.join(migrationsDir(), f), path.join(behind, f));
      expect((await planMigrations(sql, behind)).unknown).toEqual([files.at(-1)]);
      await expect(runMigrations(urls.owner, edited)).rejects.toThrow(/modified after it was applied/);
    } finally {
      await sql.end();
    }
  });

  it("refuses to migrate as the application role", async () => {
    await expect(runMigrations(urls.app)).rejects.toThrow(/Refusing to migrate as "oryn_app"/);
  });

  it("checks the connected role: the app role passes; a role that bypasses RLS is refused", async () => {
    const app = sqlFor(urls.app);
    const owner = sqlFor(urls.owner);
    try {
      expect((await checkDatabase(app, "web")).filter((i) => i.level === "error")).toEqual([]);
      const ownerIssues = await checkDatabase(owner, "web");
      expect(ownerIssues.map((i) => i.code)).toContain("db_role_bypasses_rls");
    } finally {
      await app.end();
      await owner.end();
    }
  });

  it("the cron endpoint is off without a secret and refuses wrong secrets", async () => {
    const req = (auth?: string) => new Request("http://localhost/api/cron/tick", { headers: auth ? { authorization: auth } : {} });
    vi.stubEnv("ORYN_CRON_SECRET", "");
    expect((await cronTick(req("Bearer anything"))).status).toBe(503);
    const secret = "c".repeat(20) + "-cron-secret-for-tests-0123";
    vi.stubEnv("ORYN_CRON_SECRET", secret);
    expect((await cronTick(req())).status).toBe(401);
    expect((await cronTick(req("Bearer wrong"))).status).toBe(401);
    expect((await cronTick(req(`Bearer ${secret.slice(0, -1)}x`))).status).toBe(401);
    // The tick queues platform jobs (including provider health probes) and runs
    // them; keep this test off the network.
    setProviderFetch(async () => new Response("offline in tests", { status: 503 }));
    try {
      const ok = await cronTick(req(`Bearer ${secret}`));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ tick: expect.any(Object), drained: { ran: expect.any(Number) } });
    } finally {
      setProviderFetch(null);
    }
  });

  it("a provider's retry-after sets the job's retry delay; a non-retryable provider error fails the job", async () => {
    const org = await createOrg("org-a");
    const run = (err: Error): HandlerRegistry => new Map([["test.job", { type: "test.job", describe: "t", run: async () => { throw err; } }]]);
    const a = await enqueue({ orgId: org.id, type: "test.job" });
    const [ja] = await claimJobs("w1", 1, ["test.job"]);
    await executeJob(ja!, run(new ProviderError("gdelt", "rate_limited", "429", { status: 429, retryAfterMs: 600_000 })), "w1");
    const [ra] = await ownerSql()<{ status: string; delay_s: number }[]>`select status, extract(epoch from (run_after - now()))::int as delay_s from jobs where id = ${a.id}`;
    expect(ra!.status).toBe("queued");
    expect(ra!.delay_s).toBeGreaterThanOrEqual(590);

    const b = await enqueue({ orgId: org.id, type: "test.job" });
    const [jb] = await claimJobs("w1", 1, ["test.job"]);
    await executeJob(jb!, run(new ProviderError("nws", "bad_response", "nws responded 400", { status: 400 })), "w1");
    const [rb] = await ownerSql()<{ status: string; last_error: string }[]>`select status, last_error from jobs where id = ${b.id}`;
    expect(rb).toEqual({ status: "failed", last_error: "nws responded 400" });
  });
});
