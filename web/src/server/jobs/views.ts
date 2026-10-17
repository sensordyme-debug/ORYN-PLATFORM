/**
 * Read models and controls for the processing view: jobs and processing
 * runs for one organization. Retry and cancel are audited.
 */
import { z } from "zod";
import { recordAudit } from "@/server/audit";
import type { OrgAccess } from "@/server/authz/access";
import { notFoundError } from "@/server/errors";
import { cancelJob, retryJob, type JobRow, type JobStatus } from "@/server/jobs/queue";

export type JobView = Pick<
  JobRow,
  "id" | "type" | "status" | "attempts" | "max_attempts" | "run_after" | "last_error" | "errors" | "progress" | "created_at" | "started_at" | "finished_at" | "payload" | "result"
>;

export async function listJobs(access: OrgAccess, opts: { status?: JobStatus | "active" | "problem"; aoiId?: string; limit?: number } = {}): Promise<JobView[]> {
  access.assert("jobs.read");
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  return access.tx((tx) => {
    const status =
      opts.status === "active"
        ? tx`and status in ('queued', 'running')`
        : opts.status === "problem"
          ? tx`and status in ('failed', 'dead')`
          : opts.status
            ? tx`and status = ${opts.status}`
            : tx``;
    return tx<JobView[]>`
      select id, type, status, attempts, max_attempts, run_after, last_error, errors, progress, created_at, started_at, finished_at, payload, result
        from jobs
       where org_id = ${access.org.id} ${status}
         ${opts.aoiId ? tx`and payload->>'aoiId' = ${opts.aoiId}` : tx``}
       order by created_at desc
       limit ${limit}`;
  });
}

export async function jobCounts(access: OrgAccess): Promise<Record<JobStatus, number>> {
  access.assert("jobs.read");
  return access.tx(async (tx) => {
    const rows = await tx<{ status: JobStatus; n: number }[]>`
      select status, count(*)::int as n from jobs where org_id = ${access.org.id} and created_at > now() - interval '30 days' group by status`;
    const out = { queued: 0, running: 0, succeeded: 0, failed: 0, dead: 0, cancelled: 0 } as Record<JobStatus, number>;
    for (const r of rows) out[r.status] = r.n;
    return out;
  });
}

export async function controlJob(access: OrgAccess, jobId: string, action: "retry" | "cancel") {
  access.assert("jobs.manage");
  if (!z.uuid().safeParse(jobId).success) throw notFoundError("Job");
  return access.tx(async (tx) => {
    const [j] = await tx<{ id: string; type: string }[]>`select id, type from jobs where id = ${jobId} and org_id = ${access.org.id}`;
    if (!j) throw notFoundError("Job");
    const actor = access.principal.label;
    const ok = action === "retry" ? await retryJob(tx, jobId, actor) : (await cancelJob(tx, jobId)) !== null;
    if (ok) {
      await recordAudit(tx, { orgId: access.org.id, actor: access.auditActor(), action: `job.${action}`, targetType: "job", targetId: jobId, metadata: { type: j.type }, ...access.meta });
    }
    return ok;
  });
}

export type RunView = {
  id: string;
  aoi_id: string;
  aoi_name: string;
  job_id: string | null;
  model_id: string;
  model_version: string;
  status: string;
  attempt: number;
  messages: string[];
  error: string | null;
  input_asset_ids: string[];
  baseline_asset_ids: string[];
  parameters: Record<string, unknown>;
  quality: Record<string, unknown>;
  outputs: Record<string, unknown>;
  software_version: string;
  started_at: Date;
  finished_at: Date | null;
};

export async function listRuns(access: OrgAccess, opts: { aoiId?: string; limit?: number } = {}): Promise<RunView[]> {
  access.assert("results.read");
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  return access.tx((tx) => tx<RunView[]>`
    select r.id, r.aoi_id, a.name as aoi_name, r.job_id, r.model_id, r.model_version, r.status, r.attempt, r.messages, r.error,
           r.input_asset_ids, r.baseline_asset_ids, r.parameters, r.quality, r.outputs, r.software_version, r.started_at, r.finished_at
      from processing_runs r join aois a on a.id = r.aoi_id
     where r.org_id = ${access.org.id} ${opts.aoiId ? tx`and r.aoi_id = ${opts.aoiId}` : tx``}
     order by r.started_at desc limit ${limit}`);
}
