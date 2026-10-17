/**
 * The S3 storage driver against a real S3-compatible server — imagery and
 * raster bytes, report PDFs, exports, and uploads stored and read back, plus
 * the bucket's access controls.
 *
 * Runs when TEST_S3_ENDPOINT is set (skipped otherwise). Locally:
 *
 *   docker compose --profile s3 up -d s3
 *   TEST_S3_ENDPOINT=http://127.0.0.1:8333 npm run test:integration -- storage-s3
 *
 * (Defaults match deploy/rehearsal/seaweedfs-s3.json.) Passing here shows the
 * driver works with an S3-compatible implementation that enforces SigV4 and
 * SSE-S3; each production provider (AWS S3, R2, …) must still be checked with
 * `npm run oryn:verify -- storage` in that deployment.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { fromArrayBuffer } from "geotiff";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createExport, openExportDownload } from "@/server/exports/service";
import { generateExport } from "@/server/exports/handlers";
import { createReport, openReportPdf } from "@/server/reports/service";
import { generateReport } from "@/server/reports/handlers";
import { createStorage, orgKey, probeStorage, s3BucketUrl, s3ObjectUrl, setStorageForTesting, storage, type ObjectStorage, type S3Config } from "@/server/storage";
import { loadUploadFeatures, receiveUpload } from "@/server/uploads/service";
import { closeTestDb, createOrg, insertAoi, resetDb } from "../helpers/db";
import { daysAgo, insertObservation, member, rows } from "./alerts.fixtures";

const endpoint = process.env.TEST_S3_ENDPOINT;
const cfg: S3Config = {
  bucket: process.env.TEST_S3_BUCKET ?? "oryn-test",
  region: process.env.TEST_S3_REGION ?? "us-east-1",
  endpoint,
  accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? "oryn-rehearsal-access-key",
  secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? "oryn-rehearsal-secret-key-local-only",
  forcePathStyle: true,
  sse: (process.env.TEST_S3_SSE as "AES256" | "none" | undefined) ?? "AES256",
};
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const signed = () => new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, region: cfg.region, service: "s3" });

describe.skipIf(!endpoint)("S3 object storage (S3-compatible server)", () => {
  let s3: ObjectStorage;

  beforeAll(async () => {
    const res = await signed().fetch(s3BucketUrl(cfg), { method: "PUT" });
    // 200 created; 409 already exists (re-run against a fixed TEST_S3_BUCKET).
    expect([200, 409]).toContain(res.status);
    s3 = createStorage({ driver: "s3", ...cfg });
  });
  beforeEach(async () => {
    await resetDb();
    setStorageForTesting(s3);
  });
  afterAll(async () => {
    setStorageForTesting(null);
    await closeTestDb();
  });

  it("stores imagery/raster bytes byte-for-byte, with content type and server-side encryption", async () => {
    const orgId = randomUUID();
    const key = orgKey(orgId, "rasters", randomUUID(), "scene.tif");
    const body = randomBytes(3 * 1024 * 1024 + 17); // multi-megabyte, odd length
    expect(await s3.put(key, body, "image/tiff")).toEqual({ size: body.byteLength });
    const back = await s3.get(key);
    expect(back).not.toBeNull();
    expect(back!.size).toBe(body.byteLength);
    expect(sha(back!.body)).toBe(sha(body));
    expect(back!.contentType).toBe("image/tiff");
    if (cfg.sse !== "none") {
      const head = await signed().fetch(s3ObjectUrl(s3BucketUrl(cfg), key), { method: "HEAD" });
      expect(head.headers.get("x-amz-server-side-encryption")).toBe(cfg.sse);
    }
    await s3.delete(key);
    expect(await s3.get(key)).toBeNull();
    await s3.delete(key); // idempotent
  });

  it("keeps the bucket private: anonymous reads and writes, and wrong credentials, are refused", async () => {
    const key = orgKey(randomUUID(), "reports", "r", "report.pdf");
    await s3.put(key, Buffer.from("%PDF-1.7 secret"), "application/pdf");
    const url = s3ObjectUrl(s3BucketUrl(cfg), key);
    expect([401, 403]).toContain((await fetch(url)).status);
    expect([401, 403]).toContain((await fetch(url, { method: "PUT", body: "overwrite" })).status);
    expect([401, 403]).toContain((await fetch(s3BucketUrl(cfg))).status); // no anonymous listing
    const wrong = createStorage({ driver: "s3", ...cfg, secretAccessKey: "not-the-secret" });
    await expect(wrong.get(key)).rejects.toThrow(/403/);
    await expect(wrong.put(key, Buffer.from("x"), "text/plain")).rejects.toThrow(/403/);
    expect((await s3.get(key))!.body.toString()).toBe("%PDF-1.7 secret"); // untouched
    await s3.delete(key);
  });

  it("the readiness probe writes, reads back, and deletes", async () => {
    expect(await probeStorage(s3, Date.now() + 10 * 60_000)).toBe(true);
  });

  it("reports, exports (GeoJSON, CSV, GeoTIFF, PDF), and uploads go through S3 end to end", async () => {
    const org = await createOrg("org-s3");
    const aoi = await insertAoi(org.id, "North Field");
    const analyst = await member(org, "analyst");

    // An observation raster written to S3, exported as a GeoTIFF.
    const dataKey = orgKey(org.id, "rasters", "test", "ndvi.f32");
    const values = new Float32Array([0.1, 0.2, Number.NaN, 0.4, 0.5, 0.6]);
    await storage().put(dataKey, Buffer.from(values.buffer), "application/octet-stream");
    const o = await insertObservation(org.id, aoi, {
      observedAt: daysAgo(2),
      mean: 0.4,
      raster: { png_key: orgKey(org.id, "rasters", "test", "ndvi.png"), data_key: dataKey, width: 3, height: 2, epsg: 32618, transform: [400000, 10, 0, 3970000, 0, -10], corners: [[0, 0], [0, 0], [0, 0], [0, 0]], legend: { kind: "ndvi" } },
    });
    const tif = await createExport(analyst.access, { type: "geotiff", subject: "observation_raster", params: { observationId: o.id } });
    await generateExport(org.id, tif.id);
    const tifDl = await openExportDownload(analyst.access, tif.id);
    const image = await (await fromArrayBuffer(tifDl.body.buffer.slice(tifDl.body.byteOffset, tifDl.body.byteOffset + tifDl.body.byteLength) as ArrayBuffer)).getImage();
    const [band] = (await image.readRasters()) as unknown as Float32Array[];
    expect(Array.from(band!).map((v) => (Number.isNaN(v) ? null : Math.round(v * 10) / 10))).toEqual([0.1, 0.2, null, 0.4, 0.5, 0.6]);

    // A report PDF generated into S3 and opened through the authorized path.
    const report = await createReport(analyst.access, { type: "change", aoiId: aoi });
    await generateReport(org.id, report.id);
    const pdf = await openReportPdf(analyst.access, report.id);
    expect(pdf.body.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    // GeoJSON and CSV exports.
    for (const type of ["geojson", "csv"] as const) {
      const e = await createExport(analyst.access, { type, subject: "aois" });
      await generateExport(org.id, e.id);
      const dl = await openExportDownload(analyst.access, e.id);
      expect(dl.body.byteLength).toBeGreaterThan(10);
    }

    // An upload: normalized file stored in S3.
    const geojson = JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "Upload" }, geometry: { type: "Point", coordinates: [-77.5, 35.9] } }] });
    const up = await receiveUpload(analyst.access, { name: "points.geojson", type: "application/geo+json", bytes: new TextEncoder().encode(geojson) });
    expect(up.status).toBe("validated");
    const loaded = await loadUploadFeatures(analyst.access, up.uploadId);
    expect(loaded.features).toHaveLength(1);

    // Every stored key is tenant-prefixed and readable through the S3 API itself.
    const keys = [
      ...(await rows<{ k: string }>`select storage_key as k from exports where org_id = ${org.id}`),
      ...(await rows<{ k: string }>`select pdf_storage_key as k from reports where org_id = ${org.id}`),
    ].map((r) => r.k);
    keys.push(dataKey, orgKey(org.id, "uploads", up.uploadId, "features.json"));
    expect(keys.length).toBe(6); // 3 exports + 1 report + raster + upload
    for (const k of keys) {
      expect(k.startsWith(`orgs/${org.id}/`)).toBe(true);
      const head = await signed().fetch(s3ObjectUrl(s3BucketUrl(cfg), k), { method: "HEAD" });
      expect(head.status, k).toBe(200);
    }
  });
});
