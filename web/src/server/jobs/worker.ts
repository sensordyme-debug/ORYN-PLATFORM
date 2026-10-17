/**
 * Job execution: runs claimed jobs with a timeout, heartbeats, cooperative
 * cancellation, and structured logs. Used by the long-running worker process
 * (scripts/oryn/worker.ts) and by the bounded cron endpoint.
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { log } from "@/server/log";
import {
  claimJobs,
  completeJob,
  failJob,
  heartbeat,
  JobCancelledError,
  reclaimStaleJobs,
  type JobRow,
} from "@/server/jobs/queue";

export type JobLogger = ReturnType<typeof log.child>;

export type JobContext = {
  job: JobRow;
  signal: AbortSignal;
  log: JobLogger;
  /** Persist progress (shown in the UI). Throws JobCancelledError if cancellation was requested. */
  progress(p: Record<string, unknown>): Promise<void>;
  /** Throw JobCancelledError if the job was cancelled or timed out. */
  checkpoint(): void;
};

export type JobHandler = {
  type: string;
  /** Short human description shown in the processing view. */
  describe: string;
  run(ctx: JobContext): Promise<unknown>;
};

export type HandlerRegistry = ReadonlyMap<string, JobHandler>;

export const workerId = () => `${hostname()}:${process.pid}:${randomUUID().slice(0, 6)}`;

const HEARTBEAT_MS = 15_000;

export async function executeJob(job: JobRow, registry: HandlerRegistry, wid: string): Promise<"succeeded" | string> {
  const jl = log.child({ jobId: job.id, jobType: job.type, orgId: job.org_id, attempt: job.attempts });
  const handler = registry.get(job.type);
  const controller = new AbortController();
  let cancelled = false;

  const timeout = setTimeout(() => controller.abort(new Error(`Timed out after ${job.timeout_seconds} s`)), job.timeout_seconds * 1000);
  const beat = setInterval(() => {
    heartbeat(job.id, wid)
      .then((r) => {
        if (r.cancelRequested && !cancelled) {
          cancelled = true;
          controller.abort(new JobCancelledError());
        }
      })
      .catch((err) => jl.warn("job.heartbeat_failed", { err }));
  }, HEARTBEAT_MS);

  const ctx: JobContext = {
    job,
    signal: controller.signal,
    log: jl,
    checkpoint() {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        throw reason instanceof Error ? reason : new JobCancelledError();
      }
    },
    async progress(p) {
      ctx.checkpoint();
      const r = await heartbeat(job.id, wid, p);
      if (r.cancelRequested) {
        cancelled = true;
        controller.abort(new JobCancelledError());
        throw new JobCancelledError();
      }
    },
  };

  const started = Date.now();
  try {
    if (!handler) throw new Error(`No handler registered for job type "${job.type}"`);
    jl.info("job.start");
    const result = await handler.run(ctx);
    ctx.checkpoint();
    const ok = await completeJob(job.id, wid, result);
    if (!ok) jl.warn("job.complete_lost_lock");
    jl.info("job.succeeded", { ms: Date.now() - started });
    return "succeeded";
  } catch (err) {
    const status = await failJob(job.id, wid, err);
    jl[status === "queued" ? "warn" : "error"]("job.failed", { ms: Date.now() - started, next: status, err });
    return status ?? "lost_lock";
  } finally {
    clearTimeout(timeout);
    clearInterval(beat);
  }
}

/** Claim and run jobs until none are ready or the deadline passes. Returns jobs run. */
export async function drainOnce(
  registry: HandlerRegistry,
  opts: { maxJobs: number; deadlineMs: number; concurrency?: number; types?: string[] },
): Promise<{ ran: number; outcomes: Record<string, number> }> {
  const wid = workerId();
  const outcomes: Record<string, number> = {};
  let ran = 0;
  const deadline = Date.now() + opts.deadlineMs;
  await reclaimStaleJobs();
  while (ran < opts.maxJobs && Date.now() < deadline) {
    const jobs = await claimJobs(wid, Math.min(opts.concurrency ?? 2, opts.maxJobs - ran), opts.types);
    if (jobs.length === 0) break;
    const results = await Promise.all(jobs.map((j) => executeJob(j, registry, wid)));
    for (const r of results) outcomes[r] = (outcomes[r] ?? 0) + 1;
    ran += jobs.length;
  }
  return { ran, outcomes };
}

export type WorkerStatus = {
  workerId: string;
  startedAt: number;
  /** Last completed loop iteration (claim attempt), ms epoch. */
  lastLoopAt: number;
  /** Last successful database round trip, ms epoch. */
  lastDbOkAt: number;
  inFlight: number;
  stopping: boolean;
};

/**
 * Long-running loop. Resolves after stop() once in-flight jobs finish (or are
 * abandoned at the grace deadline — they are reclaimed by another worker
 * after their heartbeat lapses, never lost).
 */
export function startWorker(
  registry: HandlerRegistry,
  opts: {
    concurrency: number;
    pollMs: number;
    onTick?: () => Promise<void>;
    tickEveryMs?: number;
    /** Called about every 15 s with the current status (e.g. to record a heartbeat). */
    onHeartbeat?: (s: WorkerStatus) => Promise<void>;
    graceMs?: number;
  },
) {
  const wid = workerId();
  const inFlight = new Set<Promise<unknown>>();
  let stopping = false;
  let lastReclaim = 0;
  let lastTick = 0;
  let lastBeat = 0;
  const state = { startedAt: Date.now(), lastLoopAt: 0, lastDbOkAt: 0 };
  const status = (): WorkerStatus => ({ workerId: wid, ...state, inFlight: inFlight.size, stopping });

  const loop = (async () => {
    log.info("worker.start", { workerId: wid, concurrency: opts.concurrency, handlers: [...registry.keys()] });
    while (!stopping) {
      try {
        const now = Date.now();
        if (now - lastReclaim > 30_000) {
          lastReclaim = now;
          const n = await reclaimStaleJobs();
          if (n) log.warn("worker.reclaimed_stale_jobs", { count: n });
        }
        if (opts.onTick && now - lastTick > (opts.tickEveryMs ?? 60_000)) {
          lastTick = now;
          await opts.onTick().catch((err) => log.error("worker.tick_failed", { err }));
        }
        if (opts.onHeartbeat && now - lastBeat > 15_000) {
          lastBeat = now;
          await opts.onHeartbeat(status()).catch((err) => log.warn("worker.heartbeat_failed", { err }));
        }
        const free = opts.concurrency - inFlight.size;
        let claimed = 0;
        if (free > 0) {
          const jobs = await claimJobs(wid, free);
          state.lastDbOkAt = Date.now();
          claimed = jobs.length;
          for (const job of jobs) {
            const p = executeJob(job, registry, wid).finally(() => inFlight.delete(p));
            inFlight.add(p);
          }
        }
        state.lastLoopAt = Date.now();
        if (claimed > 0) continue;
      } catch (err) {
        log.error("worker.loop_error", { err });
      }
      await new Promise((r) => setTimeout(r, opts.pollMs));
    }
    log.info("worker.draining", { inFlight: inFlight.size });
    const graceMs = opts.graceMs ?? 30_000;
    const drained = await Promise.race([
      Promise.allSettled([...inFlight]).then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), graceMs)),
    ]);
    // Unfinished jobs keep their 'running' row; another worker reclaims them
    // once their heartbeat lapses (counted as a failed attempt, then retried).
    log.info("worker.stopped", drained ? { drained: true } : { drained: false, abandoned: inFlight.size, graceMs });
  })();

  return {
    workerId: wid,
    status,
    stop: async () => {
      stopping = true;
      await loop;
    },
  };
}
