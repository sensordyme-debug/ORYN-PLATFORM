/**
 * Season comparisons end to end through the real job queue: catalog search
 * for both periods (fake catalog), analysis by the normal pipeline (raster
 * reads faked), pair selection, the ndvi-period-change comparison, findings,
 * explicit "nothing to compare" outcomes, permissions and area scope, alert
 * isolation, and the change evidence report with its PDF.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedAsset } from "@/server/providers/types";

type Scene = { id: string; at: string; grid?: string; epsg?: number; ndvi: number; patch?: number; unusable?: boolean };
const catalog = vi.hoisted(() => ({ scenes: [] as { id: string; at: string; grid?: string; epsg?: number; ndvi: number; patch?: number; unusable?: boolean }[] }));

vi.mock("@/server/analytics/analyze", async (orig) => {
  const real = await orig<typeof import("@/server/analytics/analyze")>();
  return { ...real, analyzeOptical: (p: { assets: Record<string, { href: string }> }) => fakeOptical(p.assets.red!.href) };
});
vi.mock("@/server/providers/imagery", () => {
  const provider = {
    descriptor: { id: "earth-search", name: "Fake Earth Search", products: [{ id: "earth-search:sentinel-2-l2a" }] },
    availability: () => ({ state: "available" }),
    resolveAccess: async (_a: unknown, key: string) => ({ url: `https://example.invalid/${key}.tif` }),
    search: async (q: { start: Date; end: Date }) =>
      catalog.scenes.filter((s) => new Date(s.at) >= q.start && new Date(s.at) <= q.end).map((s) => sceneAsset(s)),
    health: async () => ({ ok: true, latencyMs: 1 }),
  };
  return { getImageryProvider: () => provider, getImageryProduct: () => ({ provider, product: provider.descriptor.products[0] }) };
});

const { encodePng } = await import("@/server/analytics/png");
const { AccessError } = await import("@/server/authz/access");
const { claimJobs } = await import("@/server/jobs/queue");
const { executeJob } = await import("@/server/jobs/worker");
const { buildRegistry } = await import("@/server/jobs/registry");
const { createComparison, getComparison, listComparisons } = await import("@/server/comparisons/service");
const { createReport } = await import("@/server/reports/service");
const { storage } = await import("@/server/storage");
const { closeTestDb, createOrg, insertAoi, ownerSql, resetDb, SQUARE } = await import("../helpers/db");
const { grantAoi, insertRule, member, rows } = await import("./alerts.fixtures");

const W = 20;
const H = 20;
const grid = { width: W, height: H, epsg: 32618, transform: [270000, 10, 0, 3975200, 0, -10] as [number, number, number, number, number, number] };
const corners: [[number, number], [number, number], [number, number], [number, number]] = [[-77.6, 35.902], [-77.5978, 35.902], [-77.5978, 35.9002], [-77.6, 35.9002]];

function sceneAsset(s: Scene): NormalizedAsset {
  return {
    providerId: "earth-search",
    collection: "sentinel-2-l2a",
    externalId: s.id,
    kind: "optical",
    platform: "sentinel-2a",
    instruments: ["msi"],
    acquiredAt: new Date(s.at),
    acquiredEndAt: null,
    providerPublishedAt: new Date(s.at),
    footprint: SQUARE(-77.7, 35.8, 0.3),
    cloudCover: 5,
    gsdM: 10,
    epsg: s.epsg ?? 32618,
    gridCode: s.grid ?? "MGRS-18STE",
    processingLevel: "L2A",
    processingBaseline: "05.13",
    properties: { "earthsearch:boa_offset_applied": true },
    assets: { red: { href: `https://example.invalid/${s.id}/red.tif` }, nir: { href: `https://example.invalid/${s.id}/nir.tif` }, scl: { href: `https://example.invalid/${s.id}/scl.tif` }, visual: { href: `https://example.invalid/${s.id}/tci.tif` } },
    license: "Copernicus Sentinel data terms (free, full and open)",
    licenseUrl: "https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice",
    attribution: `Contains modified Copernicus Sentinel data ${s.at.slice(0, 4)}`,
    stacUrl: `https://example.invalid/items/${s.id}`,
  };
}

/** NDVI `ndvi` everywhere, with an optional 6×6-pixel patch (3,600 m²) of `patch`. */
function fakeOptical(href: string) {
  const s = catalog.scenes.find((x) => href.includes(`/${x.id}/`))!;
  const values = new Float32Array(W * H).fill(s.ndvi);
  if (s.patch !== undefined) for (let r = 4; r < 10; r++) for (let c = 4; c < 10; c++) values[r * W + c] = s.patch;
  const g = s.epsg && s.epsg !== 32618 ? { ...grid, epsg: s.epsg } : grid;
  const quality = {
    coverage_fraction: 1,
    scene_cloud_cover: 5,
    masked_fraction: s.unusable ? 0.95 : 0,
    flags: s.unusable ? ["below_min_valid_fraction"] : [],
    gsd_m: 10,
    ...(s.unusable ? { unusable_reason: "Only 5% of the area was cloud-free in this image (minimum 20%)." } : {}),
  };
  const ndvi = {
    status: s.unusable ? "unusable" : "valid",
    metrics: s.unusable ? null : { mean: s.ndvi, median: s.ndvi, p10: s.ndvi, p90: s.ndvi, std: 0, min: s.ndvi, max: s.ndvi, valid_pixels: W * H, total_pixels: W * H, valid_fraction: 1, masked_fraction: 0, pixel_area_m2: 100, histogram: { min: -1, max: 1, counts: [] } },
    quality,
    values,
    png: encodePng(new Uint8Array(W * H * 4).fill(200), W, H),
    legend: { kind: "ndvi", stops: [] },
  };
  return Promise.resolve({
    grid: g,
    corners,
    inside: new Uint8Array(W * H).fill(1),
    insideCount: W * H,
    coverageFraction: 1,
    maskReasons: {},
    ndvi,
    trueColor: { png: encodePng(new Uint8Array(W * H * 4).fill(120), W, H) },
  });
}

/** Run queued jobs (making delayed ones due) until the queue is idle. */
async function drain() {
  const registry = buildRegistry();
  for (let i = 0; i < 200; i++) {
    await ownerSql()`update jobs set run_after = now() where status = 'queued' and run_after > now()`;
    const jobs = await claimJobs("test-worker", 1);
    if (jobs.length === 0) return;
    await executeJob(jobs[0]!, registry, "test-worker");
  }
  throw new Error("queue did not drain");
}

async function setup(slug = "cmp-org") {
  const org = await createOrg(slug, "municipal");
  const aoiId = await insertAoi(org.id, "Watershed parcel", SQUARE(-77.6, 35.9, 0.01));
  await ownerSql()`update aois set enabled_analytics = '{ndvi,ndvi-change}', data_sources = '{earth-search:sentinel-2-l2a}', max_cloud_cover = 60, monitoring_enabled = true where id = ${aoiId}`;
  const analyst = await member(org, "analyst");
  return { org, aoiId, analyst };
}

const SEPT = { baseline: { from: "2025-09-01", to: "2025-09-30" }, comparison: { from: "2026-09-01", to: "2026-09-30" } };

beforeEach(async () => {
  await resetDb();
  catalog.scenes = [];
});
afterAll(closeTestDb);

describe("season comparisons", () => {
  it("compares the clearest same-grid pair of two seasons and records findings, evidence and decisions", async () => {
    const { org, aoiId, analyst } = await setup();
    // A detection_created rule must never fire on requested comparisons.
    await insertRule(org.id, "detection_created", { min_evidence_grade: "weak" });
    catalog.scenes = [
      { id: "S2A_B_CLOUDY", at: "2025-09-05T16:00:00Z", ndvi: 0.8, unusable: true },
      { id: "S2A_B_CLEAR", at: "2025-09-12T16:00:00Z", ndvi: 0.8 },
      { id: "S2A_C_CLEAR", at: "2026-09-14T16:00:00Z", ndvi: 0.8, patch: 0.3 },
    ];
    const created = await createComparison(analyst.access, aoiId, SEPT);
    expect(created.status).toBe("queued");
    await drain();

    const c = await getComparison(analyst.access, created.id);
    expect(c).toMatchObject({ status: "done", outcome: "changes_found", findings: 1 });
    expect(c.images.baseline?.externalId).toBe("S2A_B_CLEAR");
    expect(c.images.comparison?.externalId).toBe("S2A_C_CLEAR");
    expect(c.selection.decisions?.baseline.map((d) => [d.externalId, d.decision])).toEqual([["S2A_B_CLOUDY", "not_chosen"], ["S2A_B_CLEAR", "chosen"]]);
    expect(c.selection.decisions?.baseline[0]!.why).toMatch(/^Unusable: Only 5% of the area was cloud-free/);
    expect(c.result).toMatchObject({ model_id: "ndvi-period-change", model_version: "1.0.0", threshold: 0.2, min_area_m2: 2000, overlap: 1, same_grid: true, seasonal_offset_days: 2 });

    const [d] = c.items;
    expect(d).toMatchObject({ type: "vegetation_decline", areaM2: 3600, direction: "decrease", evidenceGrade: "strong" });
    expect(d!.evidenceReasons.join(" ")).toMatch(/Season-matched: the images are 2 days apart in the season/);
    const [row] = await rows<{ model_id: string; comparison_id: string; dedupe_key: string }>`select model_id, comparison_id, dedupe_key from detections where id = ${d!.id}`;
    expect(row).toMatchObject({ model_id: "ndvi-period-change", comparison_id: created.id });

    const alerts = await rows`select 1 from alerts where detection_id = ${d!.id}`;
    expect(alerts).toHaveLength(0);
    expect((await listComparisons(analyst.access, aoiId)).map((x) => x.id)).toEqual([created.id]);
  });

  it("reports no change above the threshold when the season matches", async () => {
    const { aoiId, analyst } = await setup();
    catalog.scenes = [
      { id: "B", at: "2025-09-12T16:00:00Z", ndvi: 0.8 },
      { id: "C", at: "2026-09-14T16:00:00Z", ndvi: 0.75 },
    ];
    const created = await createComparison(analyst.access, aoiId, SEPT);
    await drain();
    const c = await getComparison(analyst.access, created.id);
    expect(c).toMatchObject({ outcome: "no_change_above_threshold", findings: 0 });
    expect(c.outcomeDetail).toMatch(/No region of at least 2,000 m² changed by 0.2 NDVI or more/);
  });

  it("ends with an explicit outcome when there is nothing to compare", async () => {
    const { org, analyst } = await setup();
    let n = 0;
    // A fresh area per case: observations from earlier cases would rightly be reused.
    const run = async (scenes: Scene[]) => {
      catalog.scenes = scenes;
      const aoiId = await insertAoi(org.id, `Case ${++n}`, SQUARE(-77.6 + n * 0.05, 35.9, 0.01));
      await ownerSql()`update aois set enabled_analytics = '{ndvi}', data_sources = '{earth-search:sentinel-2-l2a}', max_cloud_cover = 60 where id = ${aoiId}`;
      const created = await createComparison(analyst.access, aoiId, SEPT);
      await drain();
      return getComparison(analyst.access, created.id);
    };
    expect(await run([{ id: "C", at: "2026-09-14T16:00:00Z", ndvi: 0.8 }])).toMatchObject({ outcome: "no_imagery_baseline" });
    expect(await run([{ id: "B1", at: "2025-09-12T16:00:00Z", ndvi: 0.8 }, { id: "C1", at: "2026-09-14T16:00:00Z", ndvi: 0.8, unusable: true }])).toMatchObject({
      outcome: "cloud_cover_comparison",
    });
    expect(
      await run([
        { id: "B2", at: "2025-09-13T16:00:00Z", ndvi: 0.8, grid: "MGRS-17SQV", epsg: 32617 },
        { id: "C2", at: "2026-09-15T16:00:00Z", ndvi: 0.8 },
      ]),
    ).toMatchObject({ outcome: "incompatible_tiles" });
  });

  it("says when the area is not set up for it", async () => {
    const { aoiId, analyst } = await setup();
    await ownerSql()`update aois set data_sources = '{planetary-computer:landsat-c2-l2}' where id = ${aoiId}`;
    const created = await createComparison(analyst.access, aoiId, SEPT);
    await drain();
    const c = await getComparison(analyst.access, created.id);
    expect(c).toMatchObject({ status: "done", outcome: "not_configured" });
    expect(c.outcomeDetail).toMatch(/Sentinel-2 L2A \(Earth Search\) is not one of the area's data sources/);
  });

  it("enforces permissions, area restrictions, tenant isolation and season matching", async () => {
    const { org, aoiId, analyst } = await setup();
    const viewer = await member(org, "viewer");
    await expect(createComparison(viewer.access, aoiId, SEPT)).rejects.toBeInstanceOf(AccessError);
    await expect(
      createComparison(analyst.access, aoiId, { baseline: { from: "2026-03-01", to: "2026-03-31" }, comparison: SEPT.comparison }),
    ).rejects.toMatchObject({ status: 422, code: "not_seasonally_comparable" });

    const created = await createComparison(analyst.access, aoiId, SEPT);
    // The same request while it runs returns the same comparison.
    expect((await createComparison(analyst.access, aoiId, SEPT)).id).toBe(created.id);

    const restricted = await member(org, "analyst", true);
    await expect(getComparison(restricted.access, created.id)).rejects.toMatchObject({ status: 404 });
    await expect(createComparison(restricted.access, aoiId, SEPT)).rejects.toMatchObject({ status: 404 });
    await grantAoi(org.id, restricted.membershipId, aoiId);
    const granted = await member(org, "viewer");
    await expect(getComparison(granted.access, created.id)).resolves.toMatchObject({ id: created.id });

    const other = await createOrg("cmp-other", "municipal");
    const outsider = await member(other, "org_admin");
    await expect(getComparison(outsider.access, created.id)).rejects.toMatchObject({ status: 404 });
    await expect(listComparisons(outsider.access, aoiId)).rejects.toMatchObject({ status: 404 });
  });

  it("renders the change evidence report from the stored comparison", async () => {
    const { org, aoiId, analyst } = await setup();
    catalog.scenes = [
      { id: "S2A_B", at: "2025-09-12T16:00:00Z", ndvi: 0.8 },
      { id: "S2A_C", at: "2026-09-14T16:00:00Z", ndvi: 0.8, patch: 0.3 },
    ];
    const created = await createComparison(analyst.access, aoiId, SEPT);
    // Not finished yet: no report.
    await expect(createReport(analyst.access, { type: "change_evidence", aoiId, params: { comparison_id: created.id } })).rejects.toMatchObject({ code: "comparison_not_done" });
    await drain();
    await expect(createReport(analyst.access, { type: "change_evidence", aoiId })).rejects.toMatchObject({ code: "invalid_report" });

    const r = await createReport(analyst.access, { type: "change_evidence", aoiId, params: { comparison_id: created.id } });
    await drain();
    const [report] = await rows<{ status: string; content: import("@/server/reports/types").ReportContent; pdf_storage_key: string; report_type: string }>`
      select status, content, pdf_storage_key, report_type from reports where id = ${r.id}`;
    expect(report).toMatchObject({ status: "ready", report_type: "change_evidence" });
    const cmp = report!.content.comparison!;
    expect(cmp).toMatchObject({ outcome: "changes_found", compared: true, periods: SEPT, method: { model_id: "ndvi-period-change", threshold: 0.2, min_area_m2: 2000 } });
    expect(cmp.images.baseline?.external_id).toBe("S2A_B");
    expect(cmp.images.comparison?.true_color_key).toMatch(new RegExp(`^orgs/${org.id}/`));
    expect(cmp.findings).toHaveLength(1);
    expect(report!.content.report.period.from.slice(0, 10)).toBe("2025-09-01");
    expect(report!.content.sources.assets.map((a) => a.external_id).sort()).toEqual(["S2A_B", "S2A_C"]);
    expect(report!.content.sources.attributions).toEqual(expect.arrayContaining(["Contains modified Copernicus Sentinel data 2025", "Contains modified Copernicus Sentinel data 2026"]));
    expect(report!.content.limitations.general.map((l) => l.text).join(" ")).toMatch(/no detection accuracy is stated/);
    const pdf = (await storage().get(report!.pdf_storage_key))!.body;
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    // Title and comparison pages plus one page for the finding.
    expect((pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
