/**
 * Long-running job worker (with the scheduler unless --no-scheduler).
 *
 *   npm run worker                    process jobs + run the scheduler
 *   npm run worker -- --no-scheduler  process jobs only (extra replicas)
 *   npm run worker -- --once          drain ready jobs and exit (CI, debugging)
 *
 * Production image: `node dist/worker.mjs` (bundled by scripts/build-scripts.mjs).
 *
 * Startup runs the production preflight (refuses unsafe configuration, an
 * application role that bypasses RLS, or pending migrations). With
 * ORYN_WORKER_HEALTH_PORT set, GET /healthz (loop alive) and GET /readyz
 * (loop alive and database reachable) are served for the orchestrator.
 * SIGTERM/SIGINT: stop claiming, finish in-flight jobs (30 s grace; jobs
 * still running are reclaimed by another worker after their heartbeat
 * lapses), then exit.
 */
import { createServer, type Server } from "node:http";
import { loadEnvConfig } from "@next/env";

async function main() {
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
  const [{ env }, { buildRegistry }, { schedulerTick }, { drainOnce, startWorker }, { withSystem, closeDb }, { registerAnalytics }, { log }, preflight, heartbeat] =
    await Promise.all([
      import("@/server/config/env"),
      import("@/server/jobs/registry"),
      import("@/server/jobs/scheduler"),
      import("@/server/jobs/worker"),
      import("@/server/db/client"),
      import("@/server/analytics/registry"),
      import("@/server/log"),
      import("@/server/config/preflight"),
      import("@/server/jobs/heartbeat"),
    ]);

  process.on("unhandledRejection", (err) => log.error("worker.unhandled_rejection", { err }));
  process.on("uncaughtException", (err) => {
    log.error("worker.fatal", { err });
    // In-flight jobs are reclaimed by another worker once their heartbeat lapses.
    process.exit(1);
  });

  try {
    await preflight.runStartupPreflight("worker");
  } catch (err) {
    if (err instanceof preflight.PreflightError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const registry = buildRegistry();
  await withSystem("worker.register_models", (tx) => registerAnalytics(tx));
  const scheduler = !process.argv.includes("--no-scheduler");

  if (process.argv.includes("--once")) {
    if (scheduler) await schedulerTick();
    const r = await drainOnce(registry, { maxJobs: 500, deadlineMs: 30 * 60_000, concurrency: env.workerConcurrency() });
    console.log(JSON.stringify(r));
    await closeDb();
    return;
  }

  const concurrency = env.workerConcurrency();
  const pollMs = env.workerPollMs();
  const worker = startWorker(registry, {
    concurrency,
    pollMs,
    onTick: scheduler ? async () => void (await schedulerTick()) : undefined,
    tickEveryMs: env.schedulerIntervalMs(),
    onHeartbeat: (s) => heartbeat.recordWorkerHeartbeat(s, { scheduler, concurrency, version: env.appVersion() }),
  });
  log.info("worker.config", { version: env.appVersion(), concurrency, pollMs, scheduler, healthPort: env.workerHealthPort() || null });

  let server: Server | null = null;
  const port = env.workerHealthPort();
  if (port) {
    const staleMs = Math.max(3 * pollMs, 60_000);
    server = createServer((req, res) => {
      const s = worker.status();
      const now = Date.now();
      const alive = !s.stopping && (s.lastLoopAt === 0 ? now - s.startedAt < staleMs : now - s.lastLoopAt < staleMs);
      const ready = alive && s.lastDbOkAt > 0 && now - s.lastDbOkAt < staleMs;
      const ok = req.url === "/healthz" ? alive : req.url === "/readyz" ? ready : null;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      if (ok === null) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      res.statusCode = ok ? 200 : 503;
      res.end(JSON.stringify({ status: ok ? "ok" : "unavailable", service: "worker", version: env.appVersion(), inFlight: s.inFlight, lastLoopSecondsAgo: s.lastLoopAt ? Math.round((now - s.lastLoopAt) / 1000) : null }));
    });
    server.listen(port, "0.0.0.0");
  }

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("worker.shutdown", { signal });
    server?.close();
    await worker.stop();
    await heartbeat.removeWorkerHeartbeat(worker.workerId).catch(() => {});
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
