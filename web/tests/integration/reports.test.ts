import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessError } from "@/server/authz/access";
import { claimJobs } from "@/server/jobs/queue";
import { JOB } from "@/server/jobs/types";
import { executeJob } from "@/server/jobs/worker";
import { generateReport, REPORT_HANDLERS } from "@/server/reports/handlers";
import { createReport, getReport, openReportPdf } from "@/server/reports/service";
import type { SummaryClient } from "@/server/reports/summarize";
import type { ReportContent } from "@/server/reports/types";
import { orgKey, setStorageForTesting, storage } from "@/server/storage";
import { closeTestDb, createOrg, insertAoi, resetDb } from "../helpers/db";
import { daysAgo, dbDaysAgo, insertDetection, insertObservation, insertRun, insertWarning, insertWeather, member, rows } from "./alerts.fixtures";

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function setup() {
  const org = await createOrg("org-a");
  const aoi = await insertAoi(org.id, "North Field");
  const analyst = await member(org, "analyst");
  return { org, aoi, analyst };
}

describe("reports", () => {
  beforeEach(async () => {
    await resetDb();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ORYN_AI_MODEL;
  });
  afterAll(closeTestDb);

  it("generates a stored PDF whose snapshot reflects stored observations and marks unusable ones", async () => {
    const { org, aoi, analyst } = await setup();
    const pngKey = orgKey(org.id, "rasters", "latest.png");
    await storage().put(pngKey, PNG_1PX, "image/png");
    const o1 = await insertObservation(org.id, aoi, { observedAt: daysAgo(30), mean: 0.72 });
    const bad = await insertObservation(org.id, aoi, { observedAt: daysAgo(20), status: "unusable", unusableReason: "97% of AOI pixels masked as cloud" });
    // The data-currency statement floors (database now − observed) to whole days.
    const latest = await insertObservation(org.id, aoi, {
      observedAt: await dbDaysAgo(4),
      mean: 0.58,
      raster: { png_key: pngKey, data_key: orgKey(org.id, "rasters", "latest.f32"), width: 1, height: 1, epsg: 32618, transform: [0, 10, 0, 0, 0, -10], corners: [[-77.601, 35.911], [-77.589, 35.911], [-77.589, 35.899], [-77.601, 35.899]], legend: { kind: "ndvi", min: -0.2, max: 0.9 } },
    });
    await insertDetection(org.id, aoi, { grade: "moderate", observedAt: daysAgo(4) });
    await insertWeather(org.id, aoi, { day: daysAgo(5).toISOString().slice(0, 10), value: 11 });
    await insertWeather(org.id, aoi, { day: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), value: 30, kind: "forecast" });
    await insertWarning(org.id, aoi);
    await insertRun(org.id, aoi, "ndvi", "failed", { error: "asset read timed out" });

    const { id, jobId } = await createReport(analyst.access, { type: "field", aoiId: aoi });
    expect(await rows`select status from reports where id = ${id}`).toEqual([{ status: "queued" }]);
    expect(await rows`select action from audit_events where target_id = ${id}`).toEqual([{ action: "report.create" }]);

    const registry = new Map(REPORT_HANDLERS.map((h) => [h.type, h]));
    const [job] = await claimJobs("w1", 1, [JOB.reportGenerate]);
    expect(job!.id).toBe(jobId);
    expect(await executeJob(job!, registry, "w1")).toBe("succeeded");

    const [r] = await rows<{ status: string; pdf_storage_key: string; pdf_size_bytes: string; summary_method: string; content: ReportContent; completed_at: Date }>`
      select status, pdf_storage_key, pdf_size_bytes, summary_method, content, completed_at from reports where id = ${id}`;
    expect(r).toMatchObject({ status: "ready", summary_method: "template", pdf_storage_key: `orgs/${org.id}/reports/${id}/report.pdf` });
    const stored = await storage().get(r!.pdf_storage_key);
    expect(stored!.body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(Number(r!.pdf_size_bytes)).toBe(stored!.size);

    const c = r!.content;
    expect(c.observations!.series.map((s) => s.observation_id)).toEqual([o1.id, bad.id, latest.id]);
    expect(c.observations!.series.find((s) => s.observation_id === bad.id)).toMatchObject({ status: "unusable", unusable_reason: "97% of AOI pixels masked as cloud" });
    expect(c.observations!.latest).toMatchObject({ observation_id: latest.id, metrics: { mean: 0.58 } });
    expect(c.data_currency.statement).toMatch(/^Latest usable imagery was acquired .* \(4 days before this report\)\.$/);
    expect(c.detections!.items).toHaveLength(1);
    expect(c.warnings!.items).toHaveLength(1);
    expect(c.weather!.kinds.find((k) => k.record_kind === "forecast")!.variables[0]).toMatchObject({ total: 30 });
    expect(c.weather!.kinds.find((k) => k.record_kind === "observation")!.variables[0]).toMatchObject({ total: 11 });
    expect(c.processing!.runs.some((x) => x.status === "failed" && x.error === "asset read timed out")).toBe(true);
    expect(c.sources.assets.length).toBeGreaterThanOrEqual(3);
    expect(c.limitations.models.map((m) => m.model_id)).toEqual(expect.arrayContaining(["ndvi", "ndvi-change"]));
    for (const o of c.observations!.series) expect(c.evidence[o.evidence_id]!.row_ids).toEqual([o.observation_id]);
    expect(c.summary!.text).toContain("Latest usable imagery");

    const fetched = await getReport(analyst.access, id);
    expect(fetched.status).toBe("ready");
    const pdf = await openReportPdf(analyst.access, id);
    expect(pdf.contentType).toBe("application/pdf");
  });

  it("says imagery is missing instead of reporting metrics when no usable imagery exists", async () => {
    const { org, aoi, analyst } = await setup();
    await insertObservation(org.id, aoi, { observedAt: daysAgo(6), status: "unusable", unusableReason: "scene covers 3% of the AOI" });
    const { id } = await createReport(analyst.access, { type: "aoi", aoiId: aoi });
    await generateReport(org.id, id);
    const { content } = await getReport(analyst.access, id);
    expect(content!.data_currency.status).toBe("missing");
    expect(content!.data_currency.statement).toMatch(/No usable imagery has been processed for this AOI/);
    expect(content!.observations!.latest).toBeNull();
    expect(content!.observations!.series[0]).toMatchObject({ status: "unusable", unusable_reason: "scene covers 3% of the AOI", metrics: { valid_fraction: 0.05 } });
    expect(content!.findings.some((f) => /NDVI/.test(f.text))).toBe(false);
    expect(content!.summary!.text).toMatch(/No usable imagery has been processed/);
  });

  it("records an AI summary when the client returns valid citations, and falls back when it fails", async () => {
    const { org, aoi, analyst } = await setup();
    await insertObservation(org.id, aoi, { observedAt: daysAgo(3), mean: 0.5 });
    const ok: SummaryClient = {
      messages: {
        parse: vi.fn(async () => ({ stop_reason: "end_turn" as const, parsed_output: { sentences: [{ text: "Imagery from 3 days ago is available [E2]." }, { text: "Pests are present [E77]." }] } })),
      },
    };
    const a = await createReport(analyst.access, { type: "change", aoiId: aoi });
    await generateReport(org.id, a.id, { summaryClient: ok });
    const [ra] = await rows<{ summary_method: string; content: ReportContent }>`select summary_method, content from reports where id = ${a.id}`;
    expect(ra!.summary_method).toBe("ai:claude-opus-5-5");
    expect(ra!.content.summary!.ai!.sentences).toHaveLength(1);
    expect(ra!.content.summary!.text).not.toContain("Pests");

    const failing: SummaryClient = { messages: { parse: async () => Promise.reject(new Error("boom")) } };
    const b = await createReport(analyst.access, { type: "change", aoiId: aoi });
    await generateReport(org.id, b.id, { summaryClient: failing });
    expect(await rows`select summary_method, status from reports where id = ${b.id}`).toEqual([{ summary_method: "template (ai_unavailable: error)", status: "ready" }]);
  });

  it("enforces permissions, AOI requirement, and tenant isolation", async () => {
    const { org, aoi, analyst } = await setup();
    const viewer = await member(org, "viewer");
    await expect(createReport(viewer.access, { type: "field", aoiId: aoi })).rejects.toBeInstanceOf(AccessError);
    await expect(createReport(analyst.access, { type: "audit" })).rejects.toBeInstanceOf(AccessError);
    await expect(createReport(analyst.access, { type: "field" })).rejects.toMatchObject({ code: "aoi_required" });
    await expect(createReport(analyst.access, { type: "field", aoiId: aoi, params: { from: "2026-10-10", to: "2026-01-01" } })).rejects.toMatchObject({ code: "invalid_report" });
    const orgB = await createOrg("org-b");
    const aoiB = await insertAoi(orgB.id, "B field");
    await expect(createReport(analyst.access, { type: "field", aoiId: aoiB })).rejects.toMatchObject({ code: "invalid_aoi" });
    const { id } = await createReport(analyst.access, { type: "field", aoiId: aoi });
    const bAdmin = await member(orgB, "org_admin");
    await expect(getReport(bAdmin.access, id)).rejects.toMatchObject({ status: 404 });

    const admin = await member(org, "org_admin");
    const audit = await createReport(admin.access, { type: "audit" });
    await generateReport(org.id, audit.id);
    const { content } = await getReport(admin.access, audit.id);
    expect(content!.audit!.events.map((e) => e.action)).toEqual(expect.arrayContaining(["report.create"]));
    await expect(getReport(analyst.access, audit.id)).rejects.toMatchObject({ status: 404 });
  });

  it("marks the report failed with the error and rethrows when generation fails", async () => {
    const { org, aoi, analyst } = await setup();
    const { id } = await createReport(analyst.access, { type: "field", aoiId: aoi });
    setStorageForTesting({
      put: async () => {
        throw new Error("object storage unavailable");
      },
      get: async () => null,
      delete: async () => {},
    });
    try {
      await expect(generateReport(org.id, id)).rejects.toThrow("object storage unavailable");
    } finally {
      setStorageForTesting(null);
    }
    expect(await rows`select status, error, pdf_storage_key from reports where id = ${id}`).toEqual([
      { status: "failed", error: "object storage unavailable", pdf_storage_key: null },
    ]);
    // A retry succeeds once storage is back.
    await generateReport(org.id, id);
    expect(await rows`select status, error from reports where id = ${id}`).toEqual([{ status: "ready", error: null }]);
  });
});
