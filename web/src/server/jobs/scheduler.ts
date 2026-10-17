/**
 * Periodic scheduling (one tick per minute from the worker, or the cron
 * endpoint). Every enqueue carries a time-bucketed idempotency key, so
 * running several schedulers concurrently — or ticking twice — never queues
 * duplicate work.
 *
 * Catalog polling is change-aware and cluster-based: AOIs that are due are
 * grouped per imagery product and clustered spatially (PostGIS
 * ST_ClusterWithin), and each cluster gets ONE catalog search. The sync job
 * then matches every new source asset against all subscribed AOIs whose
 * geometry intersects its footprint — across tenants — and queues processing
 * only for those (aoi, asset) pairs. Areas are never rescanned wholesale.
 *
 * Alert rules are also evaluated on a schedule (trigger "schedule"), not
 * only when new data arrives: otherwise a rule such as stale_observations
 * could never fire when imagery stops arriving altogether. Every monitored
 * AOI with an applicable enabled rule is evaluated once per
 * SCHEDULED_EVALUATION_MS window.
 */
import { createHash } from "node:crypto";
import { withSystem, type Tx } from "@/server/db/client";
import { log } from "@/server/log";
import { enqueueTx } from "@/server/jobs/queue";
import { JOB } from "@/server/jobs/types";
import { contextProvidersFor, enqueueContextSync } from "@/server/pipeline/context";

const IMAGERY_PREFIXES = ["earth-search:", "planetary-computer:", "copernicus-dataspace:", "nasa-cmr:"];
export const isImageryProduct = (id: string) => IMAGERY_PREFIXES.some((p) => id.startsWith(p));

/** Degrees; AOIs whose geometries are within ~50 km share one catalog search. */
const CLUSTER_DISTANCE_DEG = 0.45;
/** Catalog lookback for scheduled polls; generous because providers publish late. */
const POLL_LOOKBACK_DAYS = 10;

const bucket = (ms: number) => Math.floor(Date.now() / ms);

/** How often every monitored AOI with an enabled rule is re-evaluated. */
export const SCHEDULED_EVALUATION_MS = 6 * 3_600_000;
/** Per tick; the rest are picked up by the following ticks of the same window. */
const SCHEDULED_EVALUATION_BATCH = 500;

export const scheduledEvaluationKey = (aoiId: string, window = bucket(SCHEDULED_EVALUATION_MS)) => `alerts-schedule:${aoiId}:${window}`;

/** Queue one schedule-triggered alert evaluation per due AOI in the current window. */
export async function enqueueScheduledEvaluations(tx: Tx): Promise<number> {
  const window = bucket(SCHEDULED_EVALUATION_MS);
  const due = await tx<{ id: string; org_id: string }[]>`
    select a.id, a.org_id
      from aois a
     where a.status = 'active' and a.monitoring_enabled
       and exists (select 1 from alert_rules r where r.org_id = a.org_id and r.enabled and (r.aoi_id is null or r.aoi_id = a.id))
       and not exists (select 1 from jobs j where j.idempotency_key = 'alerts-schedule:' || a.id || ':' || ${window})
     order by a.id
     limit ${SCHEDULED_EVALUATION_BATCH}`;
  let created = 0;
  for (const a of due) {
    const r = await enqueueTx(tx, {
      orgId: a.org_id,
      type: JOB.alertsEvaluate,
      payload: { aoiId: a.id, trigger: { kind: "schedule" } },
      priority: 95,
      timeoutSeconds: 300,
      idempotencyKey: scheduledEvaluationKey(a.id, window),
    });
    if (r.created) created++;
  }
  return created;
}

export async function schedulerTick(): Promise<{ dueAois: number; catalogJobs: number; contextJobs: number; scheduledEvaluations: number }> {
  const result = await withSystem("scheduler.tick", async (tx) => {
    const due = await tx<{ id: string; org_id: string; monitoring_interval_hours: number; data_sources: string[]; news_terms: string[] }[]>`
      select id, org_id, monitoring_interval_hours, data_sources, news_terms
        from aois
       where status = 'active' and monitoring_enabled and (next_check_at is null or next_check_at <= now())
       order by next_check_at nulls first
       limit 500
       for update skip locked`;
    if (due.length === 0) return { dueAois: 0, catalogJobs: 0, contextJobs: 0 };

    let catalogJobs = 0;
    let contextJobs = 0;
    const ids = due.map((d) => d.id);
    const products = [...new Set(due.flatMap((d) => d.data_sources.filter(isImageryProduct)))];

    for (const productId of products) {
      const clusters = await tx<{ aoi_ids: string[]; bbox: [number, number, number, number] }[]>`
        with c as (
          select unnest(ST_ClusterWithin(geom, ${CLUSTER_DISTANCE_DEG})) as g
            from aois where id = any(${ids}::uuid[]) and ${productId} = any(data_sources)
        )
        select
          (select array_agg(a.id order by a.id) from aois a
            where a.id = any(${ids}::uuid[]) and ${productId} = any(a.data_sources) and ST_Intersects(a.geom, c.g)) as aoi_ids,
          array[ST_XMin(c.g), ST_YMin(c.g), ST_XMax(c.g), ST_YMax(c.g)]::float8[] as bbox
        from c`;
      for (const cl of clusters) {
        const digest = createHash("sha1").update(cl.aoi_ids.join(",")).digest("hex").slice(0, 16);
        const r = await enqueueTx(tx, {
          orgId: null,
          type: JOB.providerCatalogSync,
          payload: { productId, bbox: cl.bbox, lookbackDays: POLL_LOOKBACK_DAYS, triggeredBy: cl.aoi_ids },
          priority: 80,
          timeoutSeconds: 600,
          idempotencyKey: `psync:${productId}:${digest}:${bucket(30 * 60_000)}`,
        });
        if (r.created) catalogJobs++;
      }
    }

    for (const d of due) {
      // One job per available provider (see pipeline/context.ts).
      contextJobs += await enqueueContextSync(tx, {
        orgId: d.org_id,
        aoiId: d.id,
        providers: contextProvidersFor(d),
        reason: "scheduled",
        priority: 90,
        key: `scheduled:${bucket(d.monitoring_interval_hours * 3_600_000)}`,
      });
    }

    await tx`
      update aois set next_check_at = now() + make_interval(hours => monitoring_interval_hours), last_checked_at = now()
       where id = any(${ids}::uuid[])`;
    return { dueAois: due.length, catalogJobs, contextJobs };
  });

  const scheduledEvaluations = await withSystem("scheduler.alert_evaluations", (tx) => enqueueScheduledEvaluations(tx));

  await withSystem("scheduler.periodic", async (tx) => {
    await enqueueTx(tx, { orgId: null, type: JOB.alertsEscalate, payload: {}, priority: 70, idempotencyKey: `escalate:${bucket(15 * 60_000)}`, timeoutSeconds: 300 });
    await enqueueTx(tx, { orgId: null, type: JOB.providerHealth, payload: {}, priority: 150, idempotencyKey: `health:${bucket(30 * 60_000)}`, timeoutSeconds: 300 });
    const orgs = await tx<{ id: string }[]>`select id from organizations where archived_at is null`;
    const day = new Date().toISOString().slice(0, 10);
    for (const o of orgs) {
      await enqueueTx(tx, { orgId: o.id, type: JOB.retentionPurge, payload: {}, priority: 200, idempotencyKey: `retention:${o.id}:${day}`, timeoutSeconds: 900 });
    }
  });

  if (result.dueAois || scheduledEvaluations) log.info("scheduler.tick", { ...result, scheduledEvaluations });
  return { ...result, scheduledEvaluations };
}
