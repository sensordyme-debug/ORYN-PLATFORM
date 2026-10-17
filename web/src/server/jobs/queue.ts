/**
 * PostgreSQL job queue.
 *
 * Guarantees
 *  - Enqueue is idempotent by idempotency_key: the same unit of work is never
 *    queued twice (the existing job id is returned instead).
 *  - Claiming uses FOR UPDATE SKIP LOCKED, so concurrent workers never run
 *    the same job.
 *  - A job only becomes 'succeeded' when its handler returns. Any thrown
 *    error is recorded; retryable errors back off exponentially until
 *    max_attempts, then the job is dead-lettered ('dead'). Permanent errors
 *    fail immediately ('failed'). Both remain visible and manually retryable.
 *    Errors may describe themselves (see jobErrorPolicy): an error with
 *    `retryable === false` (e.g. a provider's 400/401/404) is permanent, and
 *    `retryAfterMs` (e.g. a provider's rate-limit cooldown) is the minimum
 *    delay before the retry.
 *  - Running jobs heartbeat. A job whose worker stops heart-beating is
 *    reclaimed and counted as a failed attempt — never silently dropped.
 */
import { jsonb, withSystem, withTenant, type Tx } from "@/server/db/client";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "dead" | "cancelled";

export type JobRow = {
  id: string;
  org_id: string | null;
  type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  run_after: Date;
  timeout_seconds: number;
  idempotency_key: string | null;
  locked_by: string | null;
  heartbeat_at: Date | null;
  progress: Record<string, unknown>;
  last_error: string | null;
  errors: { at: string; attempt: number; message: string; retryable: boolean }[];
  result: unknown;
  cancel_requested: boolean;
  parent_job_id: string | null;
  created_by: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
};

export type EnqueueOptions = {
  orgId: string | null;
  type: string;
  payload?: Record<string, unknown>;
  priority?: number;
  runAfter?: Date;
  maxAttempts?: number;
  timeoutSeconds?: number;
  idempotencyKey?: string | null;
  parentJobId?: string | null;
  createdBy?: string | null;
};

/** An error that retrying cannot fix (bad input, missing data, permission). */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

/** Thrown inside a handler when the job was cancelled. */
export class JobCancelledError extends Error {
  constructor() {
    super("Job cancelled");
    this.name = "JobCancelledError";
  }
}

/**
 * Enqueue within an existing transaction (tenant or system context).
 * Scheduling times default to the database clock, never the app server's,
 * so clock skew between hosts cannot delay or reorder work.
 */
export async function enqueueTx(tx: Tx, o: EnqueueOptions): Promise<{ id: string; created: boolean }> {
  const [row] = await tx<{ id: string }[]>`
    insert into jobs (org_id, type, payload, priority, run_after, max_attempts, timeout_seconds, idempotency_key, parent_job_id, created_by)
    values (
      ${o.orgId}, ${o.type}, ${jsonb(o.payload ?? {})}::jsonb, ${o.priority ?? 100},
      coalesce(${o.runAfter ?? null}::timestamptz, now()), ${o.maxAttempts ?? 5}, ${o.timeoutSeconds ?? 900},
      ${o.idempotencyKey ?? null}, ${o.parentJobId ?? null}, ${o.createdBy ?? null}
    )
    on conflict (idempotency_key) where idempotency_key is not null do nothing
    returning id`;
  if (row) return { id: row.id, created: true };
  const [existing] = await tx<{ id: string }[]>`select id from jobs where idempotency_key = ${o.idempotencyKey ?? ""}`;
  if (!existing) throw new Error("Idempotent enqueue conflicted with a job that is not visible in this context.");
  return { id: existing.id, created: false };
}

export async function enqueue(o: EnqueueOptions): Promise<{ id: string; created: boolean }> {
  return o.orgId
    ? withTenant({ orgId: o.orgId }, (tx) => enqueueTx(tx, o))
    : withSystem("jobs.enqueue_platform", (tx) => enqueueTx(tx, o));
}

/**
 * How a thrown error affects the job. Besides PermanentJobError, any error
 * that declares `retryable: false` is permanent (ProviderError does for
 * bad requests, refused credentials, missing resources), and `retryAfterMs`
 * sets a floor on the retry delay (rate-limit cooldowns, Retry-After).
 */
export function jobErrorPolicy(err: unknown): { retryable: boolean; retryAfterMs: number | null } {
  if (err instanceof PermanentJobError || err instanceof JobCancelledError) return { retryable: false, retryAfterMs: null };
  const e = err as { retryable?: unknown; retryAfterMs?: unknown } | null;
  const retryable = !(e && typeof e === "object" && e.retryable === false);
  const after = e && typeof e === "object" && typeof e.retryAfterMs === "number" && Number.isFinite(e.retryAfterMs) ? e.retryAfterMs : null;
  return { retryable, retryAfterMs: after };
}

/** Exponential backoff with ±20% jitter: 30 s, 60 s, 2 min, … capped at 1 h. */
export function backoffMs(attempt: number, random = Math.random): number {
  const base = Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 3_600_000);
  return Math.round(base * (0.8 + random() * 0.4));
}

export async function claimJobs(workerId: string, limit: number, types?: string[]): Promise<JobRow[]> {
  return withSystem("jobs.claim", async (tx) => {
    const typeFilter = types && types.length ? tx`and type = any(${types})` : tx``;
    return tx<JobRow[]>`
      with candidate as (
        select id from jobs
         where status = 'queued' and run_after <= now() and not cancel_requested ${typeFilter}
         order by priority, run_after
         for update skip locked
         limit ${limit}
      )
      update jobs j
         set status = 'running', attempts = j.attempts + 1, locked_by = ${workerId},
             locked_at = now(), heartbeat_at = now(), started_at = coalesce(j.started_at, now())
        from candidate c
       where j.id = c.id
      returning j.*`;
  });
}

export async function heartbeat(jobId: string, workerId: string, progress?: Record<string, unknown>): Promise<{ cancelRequested: boolean }> {
  return withSystem("jobs.heartbeat", async (tx) => {
    const [r] = await tx<{ cancel_requested: boolean }[]>`
      update jobs set heartbeat_at = now(), progress = case when ${progress ? jsonb(progress) : null}::jsonb is null then progress else ${jsonb(progress ?? {})}::jsonb end
       where id = ${jobId} and locked_by = ${workerId} and status = 'running'
      returning cancel_requested`;
    return { cancelRequested: r?.cancel_requested ?? true };
  });
}

export async function completeJob(jobId: string, workerId: string, result: unknown): Promise<boolean> {
  return withSystem("jobs.complete", async (tx) => {
    const rows = await tx`
      update jobs set status = 'succeeded', result = ${jsonb(result ?? null)}::jsonb, finished_at = now(),
                      locked_by = null, last_error = null
       where id = ${jobId} and locked_by = ${workerId} and status = 'running'
      returning id`;
    return rows.length === 1;
  });
}

export async function failJob(
  jobId: string,
  workerId: string,
  err: unknown,
  opts: { now?: Date; random?: () => number } = {},
): Promise<JobStatus | null> {
  const cancelled = err instanceof JobCancelledError;
  const policy = jobErrorPolicy(err);
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
  return withSystem("jobs.fail", async (tx) => {
    const [job] = await tx<{ attempts: number; max_attempts: number }[]>`
      select attempts, max_attempts from jobs where id = ${jobId} and locked_by = ${workerId} and status = 'running' for update`;
    if (!job) return null;
    const retryable = policy.retryable && !cancelled;
    const next: JobStatus = cancelled ? "cancelled" : !retryable ? "failed" : job.attempts >= job.max_attempts ? "dead" : "queued";
    const delay = Math.max(backoffMs(job.attempts, opts.random), Math.min(policy.retryAfterMs ?? 0, 6 * 3_600_000));
    const runAfter = new Date((opts.now ?? new Date()).getTime() + delay);
    const entry = { at: new Date().toISOString(), attempt: job.attempts, message, retryable };
    await tx`
      update jobs set
        status = ${next},
        last_error = ${message},
        errors = (errors || ${jsonb([entry])}::jsonb),
        run_after = case when ${next} = 'queued' then ${runAfter} else run_after end,
        finished_at = case when ${next} in ('dead', 'failed', 'cancelled') then now() else null end,
        locked_by = null
      where id = ${jobId}`;
    return next;
  });
}

/**
 * Reclaim jobs whose worker stopped heart-beating (crash, deploy, OOM).
 * Counts as a failed attempt so a job that kills its worker cannot loop forever.
 */
export async function reclaimStaleJobs(staleAfterSeconds = 120): Promise<number> {
  return withSystem("jobs.reclaim", async (tx) => {
    const rows = await tx`
      update jobs set
        status = case when attempts >= max_attempts then 'dead'::job_status else 'queued'::job_status end,
        last_error = 'Worker stopped responding (no heartbeat for ' || ${staleAfterSeconds}::int || ' s); attempt counted as failed.',
        errors = errors || jsonb_build_array(jsonb_build_object(
          'at', now(), 'attempt', attempts, 'message', 'heartbeat lost', 'retryable', true)),
        run_after = now() + interval '30 seconds',
        finished_at = case when attempts >= max_attempts then now() else null end,
        locked_by = null
      where status = 'running' and heartbeat_at < now() - make_interval(secs => ${staleAfterSeconds})
      returning id`;
    return rows.length;
  });
}

/** Request cancellation. Queued jobs cancel immediately; running jobs stop at their next checkpoint. */
export async function cancelJob(tx: Tx, jobId: string): Promise<JobStatus | null> {
  const [r] = await tx<{ status: JobStatus }[]>`
    update jobs set
      cancel_requested = true,
      status = case when status = 'queued' then 'cancelled'::job_status else status end,
      finished_at = case when status = 'queued' then now() else finished_at end
    where id = ${jobId} and status in ('queued', 'running')
    returning status`;
  return r?.status ?? null;
}

/** Manually requeue a failed, dead, or cancelled job. */
export async function retryJob(tx: Tx, jobId: string, actor: string): Promise<boolean> {
  const rows = await tx`
    update jobs set status = 'queued', attempts = 0, run_after = now(), cancel_requested = false, finished_at = null,
      errors = errors || jsonb_build_array(jsonb_build_object('at', now(), 'attempt', attempts, 'message', 'manual retry by ' || ${actor}::text, 'retryable', true))
    where id = ${jobId} and status in ('failed', 'dead', 'cancelled')
    returning id`;
  return rows.length === 1;
}

export async function queueStats(): Promise<{ status: JobStatus; type: string; count: number; oldest: Date | null }[]> {
  return withSystem("jobs.stats", (tx) =>
    tx<{ status: JobStatus; type: string; count: number; oldest: Date | null }[]>`
      select status, type, count(*)::int as count, min(created_at) as oldest
        from jobs where status in ('queued', 'running', 'dead', 'failed') group by status, type order by status, type`,
  );
}
