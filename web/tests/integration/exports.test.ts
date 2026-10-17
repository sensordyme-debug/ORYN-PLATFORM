import { fromArrayBuffer } from "geotiff";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AccessError } from "@/server/authz/access";
import { createExport, openExportDownload } from "@/server/exports/service";
import { generateExport } from "@/server/exports/handlers";
import { createReport } from "@/server/reports/service";
import { generateReport } from "@/server/reports/handlers";
import { orgKey, storage } from "@/server/storage";
import { closeTestDb, createOrg, insertAoi, ownerSql, resetDb } from "../helpers/db";
import { daysAgo, insertAsset, insertDetection, insertObservation, insertWeather, member, refreshAccess, rows } from "./alerts.fixtures";

async function setup() {
  const org = await createOrg("org-a");
  const aoi = await insertAoi(org.id, "North Field");
  const analyst = await member(org, "analyst");
  return { org, aoi, analyst };
}

describe("exports", () => {
  beforeEach(resetDb);
  afterAll(closeTestDb);

  it("requires exports.create (viewers are refused)", async () => {
    const { org } = await setup();
    const viewer = await member(org, "viewer");
    await expect(createExport(viewer.access, { type: "csv", subject: "aois" })).rejects.toBeInstanceOf(AccessError);
    await expect(createExport(viewer.access, { type: "csv", subject: "aois" })).rejects.toMatchObject({ status: 403 });
    expect(await rows`select id from exports`).toHaveLength(0);
  });

  it("is blocked when the organization disabled exports", async () => {
    const { org, analyst } = await setup();
    await ownerSql()`update organizations set settings = '{"exportsEnabled": false}'::jsonb where id = ${org.id}`;
    await expect(createExport(analyst.access, { type: "geojson", subject: "detections" })).rejects.toMatchObject({ status: 403, message: /disabled/ });
    const fresh = await refreshAccess(analyst, org.slug);
    await expect(createExport(fresh, { type: "geojson", subject: "detections" })).rejects.toBeInstanceOf(AccessError);
  });

  it("exports only the org's detections as GeoJSON with provenance and licence notes, and audits downloads", async () => {
    const { org, aoi, analyst } = await setup();
    const asset = await insertAsset({ acquiredAt: daysAgo(3) });
    const mine = await insertDetection(org.id, aoi, { assetIds: [asset] });
    await insertDetection(org.id, aoi, { verification: "dismissed" });
    const orgB = await createOrg("org-b");
    const aoiB = await insertAoi(orgB.id, "B field");
    const theirs = await insertDetection(orgB.id, aoiB);

    const { id } = await createExport(analyst.access, { type: "geojson", subject: "detections" });
    expect(await rows`select action from audit_events where target_id = ${id}`).toEqual([{ action: "export.create" }]);
    await generateExport(org.id, id);
    const [row] = await rows<{ status: string; content_type: string; size_bytes: string; expires_at: Date; license_notes: string[]; storage_key: string }>`
      select status, content_type, size_bytes, expires_at, license_notes, storage_key from exports where id = ${id}`;
    expect(row).toMatchObject({ status: "ready", content_type: "application/geo+json" });
    expect(row!.storage_key.startsWith(`orgs/${org.id}/exports/${id}/`)).toBe(true);
    const days = (row!.expires_at.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    expect(row!.license_notes.join(" ")).toMatch(/Copernicus Sentinel data/);

    const dl = await openExportDownload(analyst.access, id);
    expect(dl.contentType).toBe("application/geo+json");
    const fc = JSON.parse(dl.body.toString("utf8"));
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features.map((f: { id: string }) => f.id)).toEqual([mine]);
    expect(JSON.stringify(fc)).not.toContain(theirs);
    expect(fc.features[0].properties).toMatchObject({ model_id: "ndvi-change", model_version: "1.0.0", evidence_grade: "strong", verification_status: "unverified", result_class: "candidate_change" });
    expect(fc.oryn.license_notes).toEqual(row!.license_notes);
    await openExportDownload(analyst.access, id);
    expect(await rows`select download_count from exports where id = ${id}`).toEqual([{ download_count: 2 }]);
    expect(await rows`select action from audit_events where target_id = ${id} and action = 'export.download'`).toHaveLength(2);
  });

  it("a user from org B cannot open org A's export by id (not found)", async () => {
    const { org, analyst } = await setup();
    const { id } = await createExport(analyst.access, { type: "csv", subject: "aois" });
    await generateExport(org.id, id);
    const orgB = await createOrg("org-b");
    const bAdmin = await member(orgB, "org_admin");
    await expect(openExportDownload(bAdmin.access, id)).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(await rows`select download_count from exports where id = ${id}`).toEqual([{ download_count: 0 }]);
  });

  it("writes RFC 4180 CSV with formula protection and keeps weather record kinds distinct", async () => {
    const { org, analyst } = await setup();
    const aoi = await insertAoi(org.id, "=HYPERLINK(\"http://evil\"),\"x\"");
    await insertObservation(org.id, aoi, { observedAt: daysAgo(3), mean: 0.5 });
    await insertObservation(org.id, aoi, { observedAt: daysAgo(8), status: "unusable", unusableReason: "cloud, haze" });
    const { id } = await createExport(analyst.access, { type: "csv", subject: "observations", params: { aoiId: aoi } });
    await generateExport(org.id, id);
    const csv = (await openExportDownload(analyst.access, id)).body.toString("utf8");
    const lines = csv.split("\r\n");
    expect(lines[0]!.startsWith("observation_id,aoi_id,aoi_name,kind,")).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil""),""x"""`);
    expect(csv).toContain(`unusable,"cloud, haze"`);
    expect(lines).toHaveLength(4); // header + 2 records + trailing empty

    await insertWeather(org.id, aoi, { day: "2026-10-10", value: 4.2 });
    await insertWeather(org.id, aoi, { day: "2026-10-10", value: 9.9, kind: "model_estimate", providerId: "era5" });
    const w = await createExport(analyst.access, { type: "csv", subject: "weather", params: { aoiId: aoi } });
    await generateExport(org.id, w.id);
    const wcsv = (await openExportDownload(analyst.access, w.id)).body.toString("utf8");
    expect(wcsv).toMatch(/,observation,precipitation_mm,4.2,mm,/);
    expect(wcsv).toMatch(/,model_estimate,precipitation_mm,9.9,mm,/);
    const [wr] = await rows<{ license_notes: string[] }>`select license_notes from exports where id = ${w.id}`;
    expect(wr!.license_notes.join(" ")).toMatch(/Copernicus Climate Change Service/);
  });

  it("exports an observation raster as a GeoTIFF readable by geotiff.js", async () => {
    const { org, aoi, analyst } = await setup();
    const dataKey = orgKey(org.id, "rasters", "test", "ndvi.f32");
    const values = new Float32Array([0.1, 0.2, Number.NaN, 0.4, 0.5, 0.6]);
    await storage().put(dataKey, Buffer.from(values.buffer), "application/octet-stream");
    const o = await insertObservation(org.id, aoi, {
      observedAt: daysAgo(2),
      mean: 0.4,
      raster: { png_key: orgKey(org.id, "rasters", "test", "ndvi.png"), data_key: dataKey, width: 3, height: 2, epsg: 32618, transform: [400000, 10, 0, 3970000, 0, -10], corners: [[0, 0], [0, 0], [0, 0], [0, 0]], legend: { kind: "ndvi" } },
    });
    const { id } = await createExport(analyst.access, { type: "geotiff", subject: "observation_raster", params: { observationId: o.id } });
    await generateExport(org.id, id);
    const dl = await openExportDownload(analyst.access, id);
    expect(dl.filename).toMatch(/\.tif$/);
    const image = await (await fromArrayBuffer(dl.body.buffer.slice(dl.body.byteOffset, dl.body.byteOffset + dl.body.byteLength) as ArrayBuffer)).getImage();
    expect(image.getOrigin()).toEqual([400000, 3970000, 0]);
    expect(image.getGeoKeys()).toMatchObject({ ProjectedCSTypeGeoKey: 32618, GTRasterTypeGeoKey: 1 });
    const [band] = (await image.readRasters()) as unknown as Float32Array[];
    expect(Array.from(band!).map((v) => (Number.isNaN(v) ? null : Math.round(v * 10) / 10))).toEqual([0.1, 0.2, null, 0.4, 0.5, 0.6]);
  });

  it("refuses expired exports and renders report PDFs as exports", async () => {
    const { org, aoi, analyst } = await setup();
    const { id } = await createExport(analyst.access, { type: "csv", subject: "aois" });
    await generateExport(org.id, id);
    await ownerSql()`update exports set expires_at = now() - interval '1 minute' where id = ${id}`;
    await expect(openExportDownload(analyst.access, id)).rejects.toMatchObject({ code: "export_expired" });

    await insertObservation(org.id, aoi, { observedAt: daysAgo(2), mean: 0.5 });
    const report = await createReport(analyst.access, { type: "change", aoiId: aoi });
    await generateReport(org.id, report.id);
    const pdf = await createExport(analyst.access, { type: "pdf", subject: "report", params: { reportId: report.id } });
    await generateExport(org.id, pdf.id);
    const dl = await openExportDownload(analyst.access, pdf.id);
    expect(dl.contentType).toBe("application/pdf");
    expect(dl.body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
