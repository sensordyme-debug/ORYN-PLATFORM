import { fromArrayBuffer } from "geotiff";
import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "@/server/exports/csv";
import { detectionFeature, featureCollection, observationFeature, type DetectionExportRow } from "@/server/exports/geojson";
import { float32FromLittleEndian, writeFloat32GeoTiff } from "@/server/exports/geotiff";

describe("CSV", () => {
  it("quotes per RFC 4180", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("cr\rhere")).toBe('"cr\rhere"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(new Date("2026-10-01T00:00:00Z"))).toBe("2026-10-01T00:00:00.000Z");
    expect(csvCell(true)).toBe("true");
    expect(csvCell(Number.NaN)).toBe("");
  });

  it("neutralizes formula injection in text cells but keeps numbers numeric", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell("+1+1")).toBe("'+1+1");
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\t=1")).toBe("'\t=1");
    expect(csvCell("=1,2")).toBe(`"'=1,2"`);
    expect(csvCell(-0.25)).toBe("-0.25");
    expect(csvCell("a=b")).toBe("a=b");
  });

  it("renders a header and CRLF-terminated records", () => {
    const out = toCsv(
      [
        { header: "name", value: (r: { n: string; v: number }) => r.n },
        { header: "value", value: (r) => r.v },
      ],
      [
        { n: "North, field", v: 1.5 },
        { n: "=cmd", v: -2 },
      ],
    );
    expect(out).toBe('name,value\r\n"North, field",1.5\r\n\'=cmd,-2\r\n');
  });
});

describe("GeoJSON provenance", () => {
  const row: DetectionExportRow = {
    id: "d1",
    aoi_id: "a1",
    aoi_name: "North Field",
    type: "vegetation_loss",
    result_class: "candidate_change",
    title: "Vegetation decrease",
    geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    area_m2: 1200,
    model_id: "ndvi-change",
    model_version: "1.0.0",
    run_id: "run1",
    baseline_observation_id: "o1",
    comparison_observation_id: "o2",
    baseline_observed_at: new Date("2026-09-01T16:00:00Z"),
    comparison_observed_at: new Date("2026-09-11T16:00:00Z"),
    first_observed_at: new Date("2026-09-11T16:00:00Z"),
    last_observed_at: new Date("2026-09-11T16:00:00Z"),
    created_at: new Date("2026-09-12T02:00:00Z"),
    evidence_grade: "moderate",
    evidence_reasons: ["same grid"],
    verification_status: "unverified",
    verified_at: null,
    source_asset_ids: ["s1", "s2"],
    metrics: { mean_delta: -0.3 },
    thresholds: { threshold: 0.2 },
    limitations: ["A candidate is not a confirmed real-world change."],
  };

  it("carries ids, model, times, evidence grade, verification status and result class", () => {
    const f = detectionFeature(row);
    expect(f).toMatchObject({ type: "Feature", id: "d1", geometry: row.geometry });
    expect(f.properties).toMatchObject({
      detection_id: "d1",
      aoi_id: "a1",
      model_id: "ndvi-change",
      model_version: "1.0.0",
      result_class: "candidate_change",
      observed_at: "2026-09-11T16:00:00.000Z",
      processed_at: "2026-09-12T02:00:00.000Z",
      evidence_grade: "moderate",
      verification_status: "unverified",
      source_asset_ids: ["s1", "s2"],
      processing_run_id: "run1",
    });
    expect(f.properties.note).toMatch(/not a confirmed/);
    const fc = featureCollection([f], { export_id: "e1", org_id: "o", subject: "detections", generated_at: "x", license_notes: ["CC BY 4.0"], notes: [] });
    expect(JSON.parse(JSON.stringify(fc))).toMatchObject({ type: "FeatureCollection", features: [{ id: "d1" }], oryn: { license_notes: ["CC BY 4.0"] } });
  });

  it("observation features keep status, unusable reason, and drop bulky histograms", () => {
    const f = observationFeature({
      id: "o1",
      aoi_id: "a1",
      aoi_name: "North Field",
      geometry: null,
      kind: "ndvi",
      model_id: "ndvi",
      model_version: "1.0.0",
      result_class: "deterministic_calculation",
      status: "unusable",
      observed_at: new Date("2026-09-01T16:00:00Z"),
      processed_at: new Date("2026-09-01T20:00:00Z"),
      is_current: true,
      run_id: "r1",
      asset_id: "s1",
      provider_id: "earth-search",
      collection: "sentinel-2-l2a",
      external_id: "S2A_X",
      metrics: { mean: 0.1, histogram: { min: 0, max: 1, counts: [1, 2] } },
      quality: { unusable_reason: "too cloudy" },
      limitations: [],
    });
    expect(f.properties).toMatchObject({ status: "unusable", unusable_reason: "too cloudy", source_collection: "sentinel-2-l2a", model_version: "1.0.0" });
    expect(f.properties.metrics).toEqual({ mean: 0.1 });
  });
});

describe("GeoTIFF writer", () => {
  async function roundTrip(epsg: number, transform: [number, number, number, number, number, number]) {
    const width = 4;
    const height = 3;
    const data = new Float32Array(width * height).map((_, i) => i / 10 - 0.25);
    data[5] = Number.NaN;
    const buf = writeFloat32GeoTiff({ width, height, data, transform, epsg });
    const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    const image = await tiff.getImage();
    return { image, data, width, height };
  }

  it("round-trips a projected (UTM) raster through geotiff.js", async () => {
    const { image, data, width, height } = await roundTrip(32618, [500_000, 10, 0, 4_000_000, 0, -10]);
    expect(image.getWidth()).toBe(width);
    expect(image.getHeight()).toBe(height);
    expect(image.getOrigin()).toEqual([500_000, 4_000_000, 0]);
    expect(image.getResolution()).toEqual([10, -10, 0]);
    expect(image.getGeoKeys()).toMatchObject({ GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32618 });
    expect(image.getGDALNoData()).toBeNaN();
    expect(image.getSampleFormat()).toBe(3);
    expect(image.getBitsPerSample()).toBe(32);
    const [band] = (await image.readRasters()) as unknown as Float32Array[];
    expect(band).toBeInstanceOf(Float32Array);
    expect(Array.from(band!).map((v) => (Number.isNaN(v) ? "nan" : v))).toEqual(Array.from(data).map((v) => (Number.isNaN(v) ? "nan" : v)));
  });

  it("writes GeographicTypeGeoKey for EPSG:4326", async () => {
    const { image } = await roundTrip(4326, [-77.6, 0.0001, 0, 35.91, 0, -0.0001]);
    expect(image.getGeoKeys()).toMatchObject({ GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1, GeographicTypeGeoKey: 4326 });
    const [x, y] = image.getOrigin();
    expect(x).toBeCloseTo(-77.6, 10);
    expect(y).toBeCloseTo(35.91, 10);
    expect(image.getBoundingBox()[0]).toBeCloseTo(-77.6, 10);
  });

  it("rejects rotated rasters and mismatched data", () => {
    expect(() => writeFloat32GeoTiff({ width: 2, height: 2, data: new Float32Array(4), transform: [0, 1, 0.1, 0, 0, -1], epsg: 4326 })).toThrow(/Rotated/);
    expect(() => writeFloat32GeoTiff({ width: 2, height: 2, data: new Float32Array(3), transform: [0, 1, 0, 0, 0, -1], epsg: 4326 })).toThrow(/expected 4/);
  });

  it("reads little-endian Float32 storage bytes", () => {
    const b = Buffer.alloc(8);
    b.writeFloatLE(1.5, 0);
    b.writeFloatLE(Number.NaN, 4);
    const arr = float32FromLittleEndian(b.subarray(0, 8));
    expect(arr[0]).toBe(1.5);
    expect(arr[1]).toBeNaN();
  });
});
