/**
 * Re-queue change detection (and anomaly scoring) for every current usable
 * observation of one organization — used after a change-detection model
 * version changes. Results from earlier versions are kept as history.
 *
 *   npx tsx scripts/oryn/rerun-change-detection.ts <org-slug>
 */
import { loadEnvConfig } from "@next/env";

async function main() {
  loadEnvConfig(process.cwd());
  const slug = process.argv[2];
  if (!slug) throw new Error("Usage: rerun-change-detection.ts <org-slug>");
  const [{ withSystem, closeDb }, { enqueueTx }, { JOB }, { ANALYTICS }] = await Promise.all([
    import("@/server/db/client"),
    import("@/server/jobs/queue"),
    import("@/server/jobs/types"),
    import("@/server/analytics/registry"),
  ]);
  const n = await withSystem("ops.rerun_change", async (tx) => {
    const rows = await tx<{ id: string; aoi_id: string; org_id: string }[]>`
      select o.id, o.aoi_id, o.org_id from observations o join organizations g on g.id = o.org_id
       where g.slug = ${slug} and o.is_current and o.status = 'valid' and o.kind in ('ndvi', 'ndwi', 's1_water')`;
    let created = 0;
    for (const r of rows) {
      const res = await enqueueTx(tx, {
        orgId: r.org_id,
        type: JOB.aoiChangeDetection,
        payload: { aoiId: r.aoi_id, observationId: r.id, reprocess: true },
        priority: 70,
        idempotencyKey: `change:${r.id}:${ANALYTICS["ndvi-change"].version}:${ANALYTICS["water-change"].version}`,
        timeoutSeconds: 600,
      });
      if (res.created) created++;
    }
    return created;
  });
  console.log(`queued ${n} change-detection jobs for ${slug}`);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
