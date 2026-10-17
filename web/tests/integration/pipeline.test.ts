/**
 * Workflow C end to end, with the raster engine and provider replaced by
 * deterministic fakes: ingestion dedupe, cross-tenant AOI matching,
 * idempotent processing, provenance, honest handling of unusable imagery and
 * provider failures, change detection, and the historical-data flag.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedAsset } from "@/server/providers/types";

const analyzeMock = vi.hoisted(() => ({ impl: null as null | ((p: unknown) => Promise<unknown>) }));
const providerMock = vi.hoisted(() => ({ availability: { state: "available" } as { state: string; reason?: string } }));

vi.mock("@/server/analytics/analyze", async (orig) => {
  const real = await orig<typeof import("@/server/analytics/analyze")>();
  return { ...real, analyzeOptical: (p: unknown) => analyzeMock.impl!(p) };
});
vi.mock("@/server/providers/imagery", () => {
  const provider = {
    descriptor: { id: "earth-search", name: "Fake Earth Search", products: [{ id: "earth-search:sentinel-2-l2a" }] },
    availability: () => providerMock.availability,
    resolveAccess: async () => ({ url: "https://example.invalid/b.tif" }),
    search: async () => [],
    health: async () => ({ ok: true, latencyMs: 1 }),
  };
  return { getImageryProvider: () => provider, getImageryProduct: () => ({ provider, product: provider.descriptor.products[0] }) };
});

const { AssetReadError } = await import("@/server/analytics/errors");
const { withSystem } = await import("@/server/db/client");
const { claimJobs, enqueue } = await import("@/server/jobs/queue");
const { executeJob } = await import("@/server/jobs/worker");
const { buildRegistry } = await import("@/server/jobs/registry");
const { linkAndQueue, matchAssets, upsertSourceAssets } = await import("@/server/pipeline/assets");
const { gradeEvidence } = await import("@/server/pipeline/change");
const { addMember, closeTestDb, createOrg, createUser, insertAoi, ownerSql, resetDb, SQUARE } = await import("../helpers/db");

const W = 20;
const H = 20;
const grid = { width: W, height: H, epsg: 32618, transform: [270000, 10, 0, 3975200, 0, -10] as [number, number, number, number, number, number] };
const corners: [[number, number], [number, number], [number, number], [number, number]] = [[-77.6, 35.91], [-77.59, 35.91], [-77.59, 35.9], [-77.6, 35.9]];

function asset(id: string, acquired: Date, cloud = 10): NormalizedAsset {
  return {
    providerId: "earth-search",
    collection: "sentinel-2-l2a",
    externalId: id,
    kind: "optical",
    platform: "sentinel-2a",
    instruments: ["msi"],
    acquiredAt: acquired,
    acquiredEndAt: null,
    providerPublishedAt: acquired,
    footprint: SQUARE(-77.7, 35.8, 0.3),
    cloudCover: cloud,
    gsdM: 10,
    epsg: 32618,
    gridCode: "MGRS-18STE",
    processingLevel: "L2A",
    processingBaseline: "05.13",
    properties: { "earthsearch:boa_offset_applied": true },
    assets: { red: { href: "https://example.invalid/red.tif" }, nir: { href: "https://example.invalid/nir.tif" }, scl: { href: "https://example.invalid/scl.tif" } },
    license: "proprietary",
    licenseUrl: null,
    attribution: "Contains modified Copernicus Sentinel data",
    stacUrl: `https://example.invalid/items/${id}`,
  };
}

/** A fake optical result: NDVI `value` everywhere inside the AOI; `unusable` returns no metrics. */
function opticalResult(value: number, opts: { unusable?: boolean; patch?: { value: number; size: number; at?: number } } = {}) {
  const values = new Float32Array(W * H).fill(value);
  const at = opts.patch?.at ?? 0;
  if (opts.patch) for (let r = at; r < at + opts.patch.size; r++) for (let c = at; c < at + opts.patch.size; c++) values[r * W + c] = opts.patch.value;
  const inside = new Uint8Array(W * H).fill(1);
  const quality = { coverage_fraction: 1, scene_cloud_cover: 10, masked_fraction: opts.unusable ? 0.9 : 0, flags: opts.unusable ? ["below_min_valid_fraction"] : [], gsd_m: 10, ...(opts.unusable ? { unusable_reason: "Only 10% of the area was cloud-free in this image (minimum 20%)." } : {}) };
  const out = {
    status: opts.unusable ? "unusable" : "valid",
    metrics: opts.unusable ? null : { mean: value, median: value, p10: value, p90: value, std: 0, min: value, max: value, valid_pixels: W * H, total_pixels: W * H, valid_fraction: 1, masked_fraction: 0, pixel_area_m2: 100, histogram: { min: -1, max: 1, counts: [] } },
    quality,
    values,
    png: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    legend: { kind: "ndvi", stops: [] },
  };
  return { grid, corners, inside, insideCount: W * H, coverageFraction: 1, maskReasons: {}, ndvi: out };
}

async function runAll(types?: string[]) {
  const registry = buildRegistry();
  const outcomes: string[] = [];
  for (let i = 0; i < 50; i++) {
    const jobs = await claimJobs("test-worker", 1, types);
    if (jobs.length === 0) break;
    outcomes.push(await executeJob(jobs[0]!, registry, "test-worker"));
  }
  return outcomes;
}

async function setupOrg(slug = "farm-a") {
  const org = await createOrg(slug, "agriculture");
  const u = await createUser();
  await addMember(org.id, u.id, "org_admin");
  const aoiId = await insertAoi(org.id, "Field", SQUARE(-77.6, 35.9, 0.01));
  await ownerSql()`update aois set enabled_analytics = '{ndvi,ndvi-change,ndvi-anomaly}', data_sources = '{earth-search:sentinel-2-l2a}', max_cloud_cover = 40 where id = ${aoiId}`;
  return { org, aoiId };
}

async function ingest(orgId: string, aoiId: string, a: NormalizedAsset, reason = "scheduled") {
  return withSystem("test.ingest", async (tx) => {
    const up = await upsertSourceAssets(tx, [a]);
    const m = await matchAssets(tx, up.map((u) => u.id), "earth-search:sentinel-2-l2a");
    const q = await linkAndQueue(tx, m.filter((x) => x.org_id === orgId && x.aoi_id === aoiId), { productId: "earth-search:sentinel-2-l2a", reason });
    return { up, m, q };
  });
}

beforeEach(() => {
  providerMock.availability = { state: "available" };
  analyzeMock.impl = null;
});

describe("ingestion and AOI matching", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  it("deduplicates source assets and detects provider republishing without moving first_seen_at", async () => {
    const a = asset("S2A_1", new Date("2026-10-01T16:00:00Z"));
    const first = await withSystem("t", (tx) => upsertSourceAssets(tx, [a]));
    const again = await withSystem("t", (tx) => upsertSourceAssets(tx, [a]));
    expect(first[0]!.inserted).toBe(true);
    expect(again[0]).toMatchObject({ id: first[0]!.id, inserted: false, metadataChanged: false });
    const changed = await withSystem("t", (tx) => upsertSourceAssets(tx, [{ ...a, cloudCover: 55 }]));
    expect(changed[0]).toMatchObject({ id: first[0]!.id, inserted: false, metadataChanged: true });
    const rows = await ownerSql()`select count(*)::int as n, min(first_seen_at) = max(first_seen_at) as same from source_assets`;
    expect(rows[0]).toMatchObject({ n: 1, same: true });
  });

  it("matches a footprint to every subscribed intersecting AOI across tenants, with coverage", async () => {
    const { org: a, aoiId: aoiA } = await setupOrg("farm-a");
    const { org: b, aoiId: aoiB } = await setupOrg("farm-b");
    const far = await insertAoi(a.id, "Far away", SQUARE(-100, 40, 0.01));
    await ownerSql()`update aois set data_sources = '{earth-search:sentinel-2-l2a}' where id = ${far}`;
    const unsubscribed = await insertAoi(b.id, "No S2", SQUARE(-77.62, 35.9, 0.01));
    await ownerSql()`update aois set data_sources = '{nws}' where id = ${unsubscribed}`;
    const up = await withSystem("t", (tx) => upsertSourceAssets(tx, [asset("S2A_2", new Date())]));
    const m = await withSystem("t", (tx) => matchAssets(tx, [up[0]!.id], "earth-search:sentinel-2-l2a"));
    expect(m.map((x) => x.aoi_id).sort()).toEqual([aoiA, aoiB].sort());
    expect(m.map((x) => x.org_id).sort()).toEqual([a.id, b.id].sort());
    for (const x of m) expect(x.coverage).toBeCloseTo(1, 3);
  });

  it("queues processing once per (AOI, asset) and records why cloudy scenes are skipped", async () => {
    const { org, aoiId } = await setupOrg();
    const first = await ingest(org.id, aoiId, asset("S2A_3", new Date()));
    const second = await ingest(org.id, aoiId, asset("S2A_3", new Date()));
    expect(first.q).toMatchObject({ queued: 1, alreadyKnown: 0 });
    expect(second.q).toMatchObject({ queued: 0, alreadyKnown: 1 });
    const cloudy = await ingest(org.id, aoiId, asset("S2A_4", new Date(), 95));
    expect(cloudy.q.skipped).toBe(1);
    const [link] = await ownerSql()`select status, status_reason from aoi_assets l join source_assets s on s.id = l.asset_id where s.external_id = 'S2A_4'`;
    expect(link).toMatchObject({ status: "skipped" });
    expect(link!.status_reason).toMatch(/95% exceeds this area's limit of 40%/);
    const [{ n }] = (await ownerSql()`select count(*)::int as n from jobs where type = 'aoi.process_asset'`) as unknown as [{ n: number }];
    expect(n).toBe(1);
  });
});

describe("processing, provenance, and failures", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  it("stores an observation with full provenance, and re-running creates nothing new", async () => {
    const { org, aoiId } = await setupOrg();
    analyzeMock.impl = async () => opticalResult(0.62);
    await ingest(org.id, aoiId, asset("S2A_10", new Date(Date.now() - 2 * 86400000)));
    const outcomes = await runAll(["aoi.process_asset"]);
    expect(outcomes).toEqual(["succeeded"]);
    const [obs] = await ownerSql()`
      select o.*, r.model_id as run_model, r.status as run_status, r.input_asset_ids, s.external_id
        from observations o join processing_runs r on r.id = o.run_id join source_assets s on s.id = o.asset_id`;
    expect(obs).toMatchObject({ kind: "ndvi", status: "valid", model_id: "ndvi", model_version: "1.0.0", result_class: "deterministic_calculation", run_model: "ndvi", run_status: "succeeded", external_id: "S2A_10" });
    expect(obs!.metrics.mean).toBe(0.62);
    expect(obs!.raster.png_key).toMatch(/^orgs\/.+\/observations\/.+\/ndvi\.png$/);
    expect(new Date(obs!.observed_at).getTime()).toBeLessThan(new Date(obs!.processed_at).getTime());
    const follow = await ownerSql()`select type from jobs where status = 'queued' order by type`;
    expect(follow.map((j) => j.type)).toEqual(["alerts.evaluate", "aoi.change_detection"]);

    // Re-run the same work: deterministic analytics are not recomputed.
    await enqueue({ orgId: org.id, type: "aoi.process_asset", payload: { aoiId, assetId: obs!.asset_id, reason: "manual" } });
    await runAll(["aoi.process_asset"]);
    const [{ n }] = (await ownerSql()`select count(*)::int as n from observations`) as unknown as [{ n: number }];
    expect(n).toBe(1);
  });

  it("records unusable imagery honestly — reason, no metrics, no change detection", async () => {
    const { org, aoiId } = await setupOrg();
    analyzeMock.impl = async () => opticalResult(0.5, { unusable: true });
    await ingest(org.id, aoiId, asset("S2A_11", new Date()));
    await runAll(["aoi.process_asset"]);
    const [obs] = await ownerSql()`select status, metrics, quality from observations`;
    expect(obs!.status).toBe("unusable");
    expect(obs!.metrics).toEqual({});
    expect(obs!.quality.unusable_reason).toMatch(/cloud-free/);
    const [link] = await ownerSql()`select status from aoi_assets`;
    expect(link!.status).toBe("unusable");
    const change = await ownerSql()`select 1 from jobs where type = 'aoi.change_detection'`;
    expect(change).toHaveLength(0);
  });

  it("a provider outage is retried and never recorded as success", async () => {
    const { org, aoiId } = await setupOrg();
    analyzeMock.impl = async () => {
      throw new AssetReadError("HTTP 503 from asset host", { status: 503, url: "https://example.invalid/red.tif" } as never);
    };
    await ingest(org.id, aoiId, asset("S2A_12", new Date()));
    const outcomes = await runAll(["aoi.process_asset"]);
    expect(outcomes).toEqual(["queued"]);
    const [job] = await ownerSql()`select status, last_error from jobs where type = 'aoi.process_asset'`;
    expect(job!.status).toBe("queued");
    const [run] = await ownerSql()`select status, error from processing_runs`;
    expect(run).toMatchObject({ status: "failed" });
    expect((await ownerSql()`select 1 from observations`).length).toBe(0);
  });

  it("missing provider credentials fail permanently with the reason", async () => {
    const { org, aoiId } = await setupOrg();
    providerMock.availability = { state: "unconfigured", reason: "EARTHDATA_TOKEN is not set." };
    await ingest(org.id, aoiId, asset("S2A_13", new Date()));
    expect(await runAll(["aoi.process_asset"])).toEqual(["failed"]);
    const [job] = await ownerSql()`select last_error from jobs where type = 'aoi.process_asset'`;
    expect(job!.last_error).toMatch(/EARTHDATA_TOKEN/);
    expect((await ownerSql()`select 1 from observations`).length).toBe(0);
  });
});

describe("change detection", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  it("finds a candidate between two observations, grades its evidence, and never duplicates it", async () => {
    const { org, aoiId } = await setupOrg();
    analyzeMock.impl = async () => opticalResult(0.7);
    await ingest(org.id, aoiId, asset("S2A_20", new Date(Date.now() - 12 * 86400000)), "scheduled");
    await runAll(["aoi.process_asset"]);
    analyzeMock.impl = async () => opticalResult(0.7, { patch: { value: 0.2, size: 8 } });
    await ingest(org.id, aoiId, asset("S2A_21", new Date(Date.now() - 2 * 86400000)), "scheduled");
    await runAll(["aoi.process_asset"]);
    await runAll(["aoi.change_detection"]);
    const dets = await ownerSql()`select type, result_class, area_m2, evidence_grade, evidence_reasons, verification_status, metrics, source_asset_ids from detections`;
    expect(dets).toHaveLength(1);
    expect(dets[0]).toMatchObject({ type: "vegetation_decline", result_class: "candidate_change", verification_status: "unverified" });
    expect(dets[0]!.area_m2).toBeCloseTo(64 * 100, 0);
    expect(dets[0]!.metrics.mean_delta).toBeCloseTo(-0.5, 5);
    expect(dets[0]!.source_asset_ids).toHaveLength(2);
    expect(dets[0]!.evidence_reasons.join(" ")).toMatch(/threshold/);

    // Re-running change detection for the same pair adds nothing.
    const [after] = await ownerSql()`select o.id from observations o join source_assets s on s.id = o.asset_id where s.external_id = 'S2A_21' and o.kind = 'ndvi'`;
    await enqueue({ orgId: org.id, type: "aoi.change_detection", payload: { aoiId, observationId: after!.id } });
    await runAll(["aoi.change_detection"]);
    expect((await ownerSql()`select 1 from detections`).length).toBe(1);
  });

  it("marks evaluation of backfilled history as historical so it is never notified as new", async () => {
    const { org, aoiId } = await setupOrg();
    analyzeMock.impl = async () => opticalResult(0.6);
    await ingest(org.id, aoiId, asset("S2A_30", new Date(Date.now() - 60 * 86400000)), "backfill");
    await runAll(["aoi.process_asset"]);
    const [job] = await ownerSql()`select payload from jobs where type = 'alerts.evaluate'`;
    expect(job!.payload.historical).toBe(true);
  });

  it("grades evidence from explicit criteria", () => {
    const strong = gradeEvidence({ kind: "ndvi", meanDelta: -0.5, threshold: 0.2, pixelCount: 200, overlap: 0.9, sameGrid: true, daysBetween: 10, maskedBefore: 0, maskedAfter: 0.05 });
    expect(strong.grade).toBe("strong");
    const seasonal = gradeEvidence({ kind: "ndvi", meanDelta: -0.5, threshold: 0.2, pixelCount: 200, overlap: 0.9, sameGrid: true, daysBetween: 200, maskedBefore: 0, maskedAfter: 0 });
    expect(seasonal.grade).toBe("weak");
    expect(seasonal.reasons.join(" ")).toMatch(/seasonal/);
    const resampled = gradeEvidence({ kind: "ndvi", meanDelta: -0.5, threshold: 0.2, pixelCount: 200, overlap: 0.9, sameGrid: false, daysBetween: 10, maskedBefore: 0, maskedAfter: 0 });
    expect(resampled.grade).toBe("moderate");
  });
});

describe("agriculture: within-field zones, NDMI, and analytics backfill", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  /** NDVI 0.7 with a 6 × 6 px (3,600 m²) patch at 0.4 inside the field (not on its edge), or NDMI when the call asks for it. */
  function zonedOptical(p: unknown) {
    const want = (p as { want: { ndmi?: boolean } }).want;
    if (want.ndmi) {
      const r = opticalResult(0.25);
      return Promise.resolve({ ...r, ndvi: undefined, ndmi: { ...r.ndvi, legend: { kind: "ndmi", stops: [] } } });
    }
    const r = opticalResult(0.7, { patch: { value: 0.4, size: 6, at: 7 } });
    // Like the real reader: a true-colour image comes with the NDVI read when asked for.
    return Promise.resolve((want as { trueColor?: boolean }).trueColor ? { ...r, trueColor: { png: Buffer.from([0x89, 0x50]), legend: { kind: "true_color" } } } : r);
  }

  it("delineates a low-vigour zone, grades it, and confirms persistence in the next image", async () => {
    const { org, aoiId } = await setupOrg();
    await ownerSql()`update aois set enabled_analytics = '{ndvi,ndvi-zones}' where id = ${aoiId}`;
    analyzeMock.impl = zonedOptical;
    await ingest(org.id, aoiId, asset("S2A_Z1", new Date("2026-10-01T16:00:00Z")));
    await runAll();
    const first = await ownerSql()<{ type: string; result_class: string; evidence_grade: string; metrics: Record<string, unknown>; area_m2: number; baseline_observation_id: string | null }[]>`
      select type, result_class, evidence_grade, metrics, area_m2, baseline_observation_id from detections where aoi_id = ${aoiId}`;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ type: "low_vigor_zone", result_class: "deterministic_calculation", evidence_grade: "strong", area_m2: 3_600, baseline_observation_id: null });
    expect(first[0]!.metrics).toMatchObject({ rank: 1, pixel_count: 36, field_median: expect.closeTo(0.7, 5), persistence: { state: "unknown" } });
    expect(first[0]!.metrics.deficit).toBeCloseTo(0.3, 5);
    const [run] = await ownerSql()<{ status: string; parameters: Record<string, unknown> }[]>`
      select status, parameters from processing_runs where model_id = 'ndvi-zones' and aoi_id = ${aoiId}`;
    expect(run).toMatchObject({ status: "succeeded", parameters: { k: 1.5, minDeficit: 0.1, minAreaM2: 2000, persistence_window_days: 45 } });

    await ingest(org.id, aoiId, asset("S2A_Z2", new Date("2026-10-11T16:00:00Z")));
    await runAll();
    const second = await ownerSql()<{ evidence_grade: string; metrics: { persistence: { state: string; date?: string } }; evidence_reasons: string[]; first_observed_at: Date }[]>`
      select d.evidence_grade, d.metrics, d.evidence_reasons, d.first_observed_at from detections d
        join observations o on o.id = d.comparison_observation_id join source_assets s on s.id = o.asset_id
       where d.aoi_id = ${aoiId} and s.external_id = 'S2A_Z2'`;
    expect(second).toHaveLength(1);
    expect(second[0]!.metrics.persistence).toMatchObject({ state: "persistent", date: "2026-10-01" });
    expect(second[0]!.evidence_reasons.join(" ")).toMatch(/Also low in the previous usable image \(2026-10-01\)/);
    expect(second[0]!.first_observed_at.toISOString().slice(0, 10)).toBe("2026-10-01");
  });

  it("computes NDMI in its own read, without a true-colour image", async () => {
    const { org, aoiId } = await setupOrg();
    await ownerSql()`update aois set enabled_analytics = '{ndvi,ndmi}' where id = ${aoiId}`;
    const wants: unknown[] = [];
    analyzeMock.impl = (p) => {
      wants.push((p as { want: unknown }).want);
      return zonedOptical(p);
    };
    await ingest(org.id, aoiId, asset("S2A_M1", new Date("2026-10-01T16:00:00Z")));
    await runAll();
    expect(wants).toEqual([
      { ndvi: true, ndwi: false, trueColor: true },
      { ndvi: false, ndwi: false, trueColor: false, ndmi: true },
    ]);
    const obs = await ownerSql()<{ kind: string; model_id: string; status: string; raster: Record<string, unknown> }[]>`
      select kind, model_id, status, raster from observations where aoi_id = ${aoiId} order by kind`;
    expect(obs.map((o) => [o.kind, o.model_id, o.status])).toEqual([["ndmi", "ndmi", "valid"], ["ndvi", "ndvi", "valid"]]);
    expect(obs[0]!.raster.true_color_key).toBeUndefined();
    expect(obs[1]!.raster.true_color_key).toBeDefined();
  });

  it("backfills analytics enabled later onto images already processed, once", async () => {
    const { org, aoiId } = await setupOrg();
    await ownerSql()`update aois set enabled_analytics = '{ndvi}' where id = ${aoiId}`;
    analyzeMock.impl = zonedOptical;
    await ingest(org.id, aoiId, asset("S2A_B1", new Date(Date.now() - 5 * 86_400_000)));
    await runAll();
    expect((await ownerSql()`select count(*)::int as n from detections where aoi_id = ${aoiId}`)[0]!.n).toBe(0);

    const { member } = await import("./alerts.fixtures");
    const { updateAoi } = await import("@/server/aois/service");
    const admin = await member(org, "org_admin");
    await updateAoi(admin.access, aoiId, { enabledAnalytics: ["ndvi", "ndmi", "ndvi-zones"] });
    const queued = await ownerSql()<{ type: string; key: string; payload: Record<string, unknown> }[]>`
      select type, idempotency_key as key, payload from jobs where status = 'queued' and type in ('aoi.process_asset', 'aoi.change_detection') order by type`;
    expect(queued.map((j) => j.type)).toEqual(["aoi.change_detection", "aoi.process_asset"]);
    expect(queued[0]!.payload).toMatchObject({ followUps: ["ndvi-zones"], historical: true });
    expect(queued[1]!.key).toMatch(/^process:.*:analytics:[0-9a-f]{12}$/);

    await runAll();
    const kinds = await ownerSql()<{ kind: string }[]>`select kind from observations where aoi_id = ${aoiId} order by kind`;
    expect(kinds.map((k) => k.kind)).toEqual(["ndmi", "ndvi"]);
    expect((await ownerSql()`select count(*)::int as n from detections where aoi_id = ${aoiId} and type = 'low_vigor_zone'`)[0]!.n).toBe(1);
    // Saving the same settings again queues nothing new.
    await updateAoi(admin.access, aoiId, { enabledAnalytics: ["ndvi", "ndmi", "ndvi-zones"] });
    expect((await ownerSql()`select count(*)::int as n from jobs where status = 'queued'`)[0]!.n).toBe(0);
  });
});

describe("one acquisition delivered as several items (granules, neighbouring tiles)", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  async function ingestBatch(orgId: string, aoiId: string, assets: NormalizedAsset[]) {
    return withSystem("test.ingest", async (tx) => {
      const up = await upsertSourceAssets(tx, assets);
      const m = await matchAssets(tx, up.map((u) => u.id), "earth-search:sentinel-2-l2a");
      return linkAndQueue(tx, m.filter((x) => x.org_id === orgId && x.aoi_id === aoiId), { productId: "earth-search:sentinel-2-l2a", reason: "scheduled" });
    });
  }
  const links = (aoiId: string) =>
    ownerSql()<{ external_id: string; status: string; status_reason: string | null }[]>`
      select s.external_id, l.status, l.status_reason from aoi_assets l join source_assets s on s.id = l.asset_id where l.aoi_id = ${aoiId} order by s.external_id`;
  const t = new Date("2026-10-01T16:13:27Z");
  const plus = (s: number) => new Date(t.getTime() + s * 1000);

  it("processes one granule of a pass and records why the other was skipped", async () => {
    const { org, aoiId } = await setupOrg();
    const q = await ingestBatch(org.id, aoiId, [asset("S2B_X_0", t), asset("S2B_X_1", plus(7))]);
    expect(q).toMatchObject({ queued: 1, skipped: 1 });
    const l = await links(aoiId);
    expect(l.map((x) => [x.external_id, x.status])).toEqual([["S2B_X_0", "queued"], ["S2B_X_1", "skipped"]]);
    expect(l[1]!.status_reason).toMatch(/^Same acquisition as S2B_X_0 \(sentinel-2a, another granule or tile of the same pass\)/);
  });

  it("prefers the tile in the area's own UTM zone, whatever the order", async () => {
    const { org, aoiId } = await setupOrg(); // AOI at −77.6°: UTM zone 18
    const otherZone = { ...asset("S2B_17ZZZ", t), epsg: 32617, gridCode: "MGRS-17ZZZ" };
    const ownZone = asset("S2B_18STE", plus(1));
    await ingestBatch(org.id, aoiId, [otherZone, ownZone]);
    expect((await links(aoiId)).map((x) => [x.external_id, x.status])).toEqual([["S2B_17ZZZ", "skipped"], ["S2B_18STE", "queued"]]);
  });

  it("keeps separate acquisitions: another satellite the same day, or the same satellite much later", async () => {
    const { org, aoiId } = await setupOrg();
    await ingestBatch(org.id, aoiId, [asset("S2B_A", t), { ...asset("S2A_B", plus(600)), platform: "sentinel-2b" }, asset("S2B_C", plus(3600))]);
    expect((await links(aoiId)).every((x) => x.status === "queued")).toBe(true);
  });

  it("processes every granule when none covers the whole area (no mosaicking)", async () => {
    const { org, aoiId } = await setupOrg(); // AOI: SQUARE(−77.6, 35.9, 0.01)
    const west = { ...asset("S2B_W", t), footprint: SQUARE(-77.7, 35.8, 0.105) }; // ends at −77.595: half the AOI
    const east = { ...asset("S2B_E", plus(7)), footprint: SQUARE(-77.595, 35.8, 0.3) };
    await ingestBatch(org.id, aoiId, [west, east]);
    expect((await links(aoiId)).map((x) => x.status)).toEqual(["queued", "queued"]);
  });

  it("skips a duplicate that arrives in a later search", async () => {
    const { org, aoiId } = await setupOrg();
    await ingestBatch(org.id, aoiId, [asset("S2B_Y_0", t)]);
    const later = await ingestBatch(org.id, aoiId, [asset("S2B_Y_1", plus(7))]);
    expect(later).toMatchObject({ queued: 0, skipped: 1 });
  });
});
