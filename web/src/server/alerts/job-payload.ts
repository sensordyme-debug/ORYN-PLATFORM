/**
 * Shared helpers for the alerting, report, export, and retention job
 * handlers: payload validation and org requirement. A malformed payload can
 * never succeed on retry, so it fails permanently.
 */
import type { z } from "zod";
import { PermanentJobError } from "@/server/jobs/queue";
import type { JobContext } from "@/server/jobs/worker";

export function parsePayload<T extends z.ZodType>(schema: T, ctx: JobContext): z.output<T> {
  const r = schema.safeParse(ctx.job.payload ?? {});
  if (!r.success) {
    throw new PermanentJobError(`Invalid ${ctx.job.type} payload: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return r.data;
}

export function requireOrg(ctx: JobContext): string {
  if (!ctx.job.org_id) throw new PermanentJobError(`${ctx.job.type} must be enqueued for an organization.`);
  return ctx.job.org_id;
}
