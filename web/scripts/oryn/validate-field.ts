/**
 * Real-data validation of the agriculture pipeline on one public research
 * field — development databases only.
 *
 *   npx tsx scripts/oryn/validate-field.ts [--days 180]
 *   npx tsx scripts/oryn/validate-field.ts --zones-only   # recompute zones on the stored NDVI (local data only)
 *   npx tsx scripts/oryn/validate-field.ts --aoi-name "US-Ne1 run 2"   # a fresh area with the same boundary
 *
 * Creates (once) a local organization "validation-mead" (agriculture, not
 * synthetic) with an area of interest over the University of Nebraska–
 * Lincoln Mead site US-Ne1, an irrigated centre-pivot maize field and
 * AmeriFlux site (pivot centre 41.16506 N, 96.47664 W; the AOI is a 390 m
 * radius circle inside the pivot). It then runs the real catalog search
 * (Earth Search Sentinel-2 L2A), per-image processing, and follow-up
 * analyses for THIS organization's jobs only, and prints what was produced.
 *
 * Network: public STAC search and HTTP range reads of public COGs; no
 * credentials. Refuses NODE_ENV=production.
 */
import { loadEnvConfig } from "@next/env";

const ORG_SLUG = "validation-mead";
const CENTER: [number, number] = [-96.47664, 41.16506];
const RADIUS_M = 390;
const ANALYTICS = ["ndvi", "ndmi", "ndvi-zones", "ndvi-change", "ndvi-anomaly"];

async function main() {
  loadEnvConfig(process.cwd(), true);
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to run against a production configuration.");
  const days = Number(process.argv[process.argv.indexOf("--days") + 1]) || 180;
  const nameIdx = process.argv.indexOf("--aoi-name");
  const aoiName = nameIdx > 0 && process.argv[nameIdx + 1] ? process.argv[nameIdx + 1]! : "US-Ne1 centre pivot";
  const [{ default: postgres }, { executeJob }, { buildRegistry }, { enqueue }, { closeDb }, { registerAnalytics }, { withSystem }] = await Promise.all([
    import("postgres"),
    import("@/server/jobs/worker"),
    import("@/server/jobs/registry"),
    import("@/server/jobs/queue"),
    import("@/server/db/client"),
    import("@/server/analytics/registry"),
    import("@/server/db/client"),
  ]);
  const owner = postgres(process.env.DATABASE_OWNER_URL!, { max: 1, onnotice: () => {} });
  try {
    await withSystem("validate.register", (tx) => registerAnalytics(tx));
    await owner`insert into organizations (slug, name, kind, is_synthetic) values (${ORG_SLUG}, 'Validation — UNL Mead US-Ne1', 'agriculture', false) on conflict (slug) do nothing`;
    const [org] = await owner<{ id: string }[]>`select id from organizations where slug = ${ORG_SLUG}`;
    let [aoi] = await owner<{ id: string }[]>`select id from aois where org_id = ${org!.id} and name = ${aoiName}`;
    if (!aoi) {
      [aoi] = await owner<{ id: string }[]>`
        insert into aois (org_id, name, description, kind, geom, input_geom, boundary_source, data_sources, enabled_analytics, max_cloud_cover, monitoring_enabled)
        values (${org!.id}, ${aoiName},
                'UNL Mead AmeriFlux site US-Ne1 (irrigated maize). 390 m radius around the published pivot centre.', 'field',
                ST_Multi(ST_Buffer(ST_SetSRID(ST_Point(${CENTER[0]}, ${CENTER[1]}), 4326)::geography, ${RADIUS_M}, 32)::geometry),
                ST_SetSRID(ST_Point(${CENTER[0]}, ${CENTER[1]}), 4326),
                ${owner.json({ method: "buffered_point", note: "Published AmeriFlux US-Ne1 pivot centre, buffered 390 m", retrieved_at: new Date().toISOString() })},
                ${["earth-search:sentinel-2-l2a"]}, ${ANALYTICS}, 60, false)
        returning id`;
    }
    console.log(`org ${ORG_SLUG} ${org!.id}  aoi ${aoi!.id}`);
    if (process.argv.includes("--zones-only")) {
      // Local validation data only: replace this AOI's zones with a fresh computation on the stored NDVI.
      await owner`delete from detections where aoi_id = ${aoi!.id} and type = 'low_vigor_zone'`;
      await owner`delete from processing_runs where aoi_id = ${aoi!.id} and model_id = 'ndvi-zones'`;
      const obs = await owner<{ id: string }[]>`select id from observations where aoi_id = ${aoi!.id} and kind = 'ndvi' and status = 'valid' and is_current`;
      const stamp = Date.now();
      for (const o of obs) {
        await enqueue({ orgId: org!.id, type: "aoi.change_detection", payload: { aoiId: aoi!.id, observationId: o.id, historical: true, followUps: ["ndvi-zones"] }, priority: 70, idempotencyKey: `validate-zones:${o.id}:${stamp}` });
      }
    } else {
      await enqueue({ orgId: org!.id, type: "aoi.catalog_sync", payload: { aoiId: aoi!.id, mode: "backfill", lookbackDays: days, reason: "validation" }, priority: 50, idempotencyKey: `validate:${aoi!.id}:${Date.now()}` });
    }

    const registry = buildRegistry();
    const outcomes: Record<string, number> = {};
    const started = Date.now();
    for (let i = 0; i < 2_000; i++) {
      // Claim only this organization's jobs (same semantics as claimJobs).
      const [job] = await withSystem("validate.claim", (tx) => tx`
        with candidate as (
          select id from jobs where status = 'queued' and run_after <= now() and not cancel_requested and org_id = ${org!.id}
           order by priority, run_after for update skip locked limit 1)
        update jobs j set status = 'running', attempts = j.attempts + 1, locked_by = 'validate', locked_at = now(), heartbeat_at = now(),
               started_at = coalesce(j.started_at, now())
          from candidate c where j.id = c.id returning j.*`);
      if (!job) {
        const [waiting] = await owner<{ n: number }[]>`select count(*)::int as n from jobs where org_id = ${org!.id} and status = 'queued'`;
        if (!waiting!.n) break;
        await new Promise((r) => setTimeout(r, 2_000));
        continue;
      }
      const outcome = await executeJob(job as never, registry, "validate");
      const key = `${(job as { type: string }).type} → ${outcome}`;
      outcomes[key] = (outcomes[key] ?? 0) + 1;
      if (i % 10 === 0) process.stdout.write(".");
    }
    console.log(`\njobs (${Math.round((Date.now() - started) / 1000)} s):`);
    for (const [k, n] of Object.entries(outcomes).sort()) console.log(`  ${k}: ${n}`);

    const obs = await owner<{ kind: string; status: string; n: number; first: string; last: string }[]>`
      select kind, status, count(*)::int as n, min(observed_at)::date::text as first, max(observed_at)::date::text as last
        from observations where aoi_id = ${aoi!.id} and is_current group by kind, status order by kind, status`;
    console.log("observations:");
    for (const o of obs) console.log(`  ${o.kind.padEnd(13)} ${o.status.padEnd(9)} n=${String(o.n).padStart(3)}  ${o.first} … ${o.last}`);
    const dets = await owner<{ type: string; grade: string; n: number }[]>`
      select type, evidence_grade as grade, count(*)::int as n from detections where aoi_id = ${aoi!.id} group by 1, 2 order by 1, 2`;
    console.log("detections:");
    for (const d of dets) console.log(`  ${d.type.padEnd(20)} ${d.grade.padEnd(9)} n=${d.n}`);
  } finally {
    await owner.end({ timeout: 5 });
    await closeDb();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
