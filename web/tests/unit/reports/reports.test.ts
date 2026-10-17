import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildReportContent, type ObservationSourceRow, type ReportSource } from "@/server/reports/assemble";
import { pdfSafe, renderReportPdf } from "@/server/reports/pdf";
import { AI_SYSTEM_PROMPT, aiInput, citedIds, summarizeReport, templateSummary, validateCitations, type SummaryClient } from "@/server/reports/summarize";
import { REPORT_SECTIONS } from "@/server/reports/types";

const GEN = new Date("2026-10-15T12:00:00Z");
const DAY = 86_400_000;
const ago = (d: number) => new Date(GEN.getTime() - d * DAY);
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function obs(id: string, daysAgo: number, mean: number, extra: Partial<ObservationSourceRow> = {}): ObservationSourceRow {
  return {
    id,
    aoi_id: "aoi-1",
    kind: "ndvi",
    model_id: "ndvi",
    model_version: "1.0.0",
    result_class: "deterministic_calculation",
    status: "valid",
    observed_at: ago(daysAgo),
    processed_at: ago(daysAgo - 0.5),
    is_current: true,
    metrics: { mean, median: mean, p10: mean - 0.1, p90: mean + 0.1, valid_fraction: 0.9, histogram: { min: 0, max: 1, counts: [1] } },
    quality: { coverage_fraction: 1, masked_fraction: 0.1, scene_cloud_cover: 4, flags: [], gsd_m: 10 },
    raster: null,
    asset_id: `asset-${id}`,
    provider_id: "earth-search",
    collection: "sentinel-2-l2a",
    platform: "sentinel-2b",
    ...extra,
  };
}

function source(over: Partial<ReportSource> = {}): ReportSource {
  const latest = obs("o3", 23, 0.62, {
    raster: {
      png_key: "orgs/org-1/rasters/o3.png",
      data_key: "orgs/org-1/rasters/o3.f32",
      width: 1,
      height: 1,
      epsg: 32618,
      transform: [0, 10, 0, 0, 0, -10],
      corners: [[-77.601, 35.911], [-77.589, 35.911], [-77.589, 35.899], [-77.601, 35.899]],
      legend: { kind: "ndvi", min: -0.2, max: 0.9, stops: [{ value: 0, color: "#a50026", label: "0" }, { value: 0.8, color: "#006837", label: "0.8" }] },
    },
  });
  return {
    report: { id: "rep-1", type: "field", title: "Field report — North Field", params: {}, from: ago(90), to: GEN, generatedAt: GEN },
    sections: REPORT_SECTIONS.field,
    org: { id: "org-1", name: "Org One", slug: "org-one", kind: "agriculture", is_synthetic: false },
    aoi: {
      id: "aoi-1",
      name: "North Field",
      kind: "field",
      status: "active",
      area_m2: 1_000_000,
      lon: -77.595,
      lat: 35.905,
      bbox: [-77.6, 35.9, -77.59, 35.91],
      geometry: { type: "MultiPolygon", coordinates: [[[[-77.6, 35.9], [-77.59, 35.9], [-77.59, 35.91], [-77.6, 35.91], [-77.6, 35.9]]]] },
      boundary_source: { method: "drawn" },
      is_synthetic: false,
      created_at: ago(200),
    },
    observations: [obs("o1", 60, 0.71), obs("o2", 40, 0.1, { status: "unusable", quality: { unusable_reason: "92% of AOI pixels masked as cloud", flags: [], gsd_m: 10, coverage_fraction: 1, masked_fraction: 0.92, scene_cloud_cover: 88 } }), latest],
    latestValid: latest,
    detections: [],
    weather: [
      { id: "1", provider_id: "noaa-ghcnd", record_kind: "observation", variable: "precipitation_mm", value: 12.5, unit: "mm", valid_from: new Date("2026-10-10T00:00:00Z"), valid_to: new Date("2026-10-11T00:00:00Z"), issued_at: null, retrieved_at: ago(1), station_id: "S1", station_distance_km: 5 },
      { id: "2", provider_id: "noaa-ghcnd", record_kind: "observation", variable: "precipitation_mm", value: 3, unit: "mm", valid_from: new Date("2026-10-11T00:00:00Z"), valid_to: new Date("2026-10-12T00:00:00Z"), issued_at: null, retrieved_at: ago(1), station_id: "S1", station_distance_km: 5 },
      { id: "3", provider_id: "open-meteo", record_kind: "forecast", variable: "precipitation_mm", value: 20, unit: "mm", valid_from: new Date("2026-10-16T00:00:00Z"), valid_to: new Date("2026-10-17T00:00:00Z"), issued_at: ago(0.2), retrieved_at: ago(0.1), station_id: null, station_distance_km: null },
    ],
    warnings: [],
    news: [],
    reportedEvents: [],
    alerts: [],
    runs: [
      { id: "run-1", aoi_id: "aoi-1", model_id: "ndvi", model_version: "1.0.0", status: "succeeded", started_at: ago(23), finished_at: ago(23), input_asset_ids: ["asset-o3"], messages: [], error: null, software_version: "dev" },
    ],
    assets: [
      { id: "asset-o3", provider_id: "earth-search", collection: "sentinel-2-l2a", external_id: "S2B_18SUD_20260922", platform: "sentinel-2b", acquired_at: ago(23), cloud_cover: 4, license: "proprietary", license_url: "https://sentinel.esa.int/documents/247904/690755/Sentinel_Data_Legal_Notice", attribution: null, stac_url: null },
    ],
    models: [{ id: "ndvi", version: "1.0.0", name: "Normalized Difference Vegetation Index", result_class: "deterministic_calculation", limitations: ["Requires multispectral surface reflectance; never computed from RGB imagery."] }],
    audit: [],
    ...over,
  };
}

describe("report content", () => {
  it("states stale imagery, keeps unusable observations with reasons, and indexes evidence for every number", () => {
    const c = buildReportContent(source());
    expect(c.data_currency.status).toBe("stale");
    expect(c.data_currency.statement).toBe("Latest usable imagery is 23 days old (acquired 2026-09-22); conditions may have changed since.");
    expect(c.observations!.statement.status).toBe("stale");
    const unusable = c.observations!.series.find((o) => o.status === "unusable")!;
    expect(unusable.unusable_reason).toBe("92% of AOI pixels masked as cloud");
    expect(c.observations!.unusable_count).toBe(1);
    expect(c.observations!.latest!.observation_id).toBe("o3");
    expect(c.observations!.latest!.metrics).not.toHaveProperty("histogram");
    for (const o of c.observations!.series) expect(c.evidence[o.evidence_id]).toMatchObject({ table: "observations", row_ids: [o.observation_id] });
    // Weather kinds are summarized separately.
    const kinds = Object.fromEntries(c.weather!.kinds.map((k) => [k.record_kind, k]));
    expect(kinds.observation!.variables[0]).toMatchObject({ variable: "precipitation_mm", total: 15.5, days: 2 });
    expect(c.evidence[kinds.observation!.variables[0]!.evidence_id]!.row_ids).toEqual(["1", "2"]);
    expect(kinds.forecast!.variables[0]).toMatchObject({ total: 20 });
    expect(kinds.model_estimate!.statement.status).toBe("missing");
    // Findings cite existing evidence only.
    for (const f of c.findings) for (const id of f.evidence_ids) expect(c.evidence[id], id).toBeDefined();
    expect(c.findings.some((f) => /^Forecast precipitation for 2026-10-16 to 2026-10-16 \(issued 2026-10-15 07:12 UTC\): total 20 mm/.test(f.text))).toBe(true);
    // Limitations come from the stored model registry rows and carry L ids.
    expect(c.limitations.models[0]!.limitations[0]!.id).toMatch(/^L\d+$/);
    expect(c.evidence[c.limitations.models[0]!.limitations[0]!.id]!.kind).toBe("limitation");
  });

  it("counts images, not analyses, and reports the NDVI range rather than first-vs-last", () => {
    const cloudy = { unusable_reason: "95% of AOI pixels masked as cloud", flags: [], gsd_m: 10, coverage_fraction: 1, masked_fraction: 0.95, scene_cloud_cover: 90 };
    const c = buildReportContent(
      source({
        observations: [
          obs("bare", 150, 0.17),
          // One image, three analyses: NDVI and NDMI usable, the anomaly score lacks history.
          obs("peak", 80, 0.91, { asset_id: "asset-peak" }),
          obs("peak-ndmi", 80, 0.4, { kind: "ndmi", model_id: "ndmi", asset_id: "asset-peak" }),
          obs("peak-anomaly", 80, 0.91, { kind: "ndvi_anomaly", model_id: "ndvi-anomaly", status: "unusable", asset_id: "asset-peak", quality: { ...cloudy, unusable_reason: "Insufficient baseline: 1 earlier usable acquisition date (at least 3 needed)." } }),
          // A cloudy image: both analyses unusable.
          obs("cloud", 60, 0.2, { status: "unusable", asset_id: "asset-cloud", quality: cloudy }),
          obs("cloud-ndmi", 60, 0.1, { kind: "ndmi", model_id: "ndmi", status: "unusable", asset_id: "asset-cloud", quality: cloudy }),
          obs("harvest", 30, 0.3),
        ],
      }),
    );
    const texts = c.findings.map((f) => f.text);
    expect(texts).toContainEqual(expect.stringMatching(/^1 of 4 images in the period were unusable for analysis \(95% of AOI pixels masked as cloud\)\.$/));
    expect(texts.join(" ")).not.toMatch(/Insufficient baseline/);
    expect(texts).toContainEqual(expect.stringMatching(/across 3 usable observations: lowest 0\.17 on .*, highest 0\.91 on .*, latest 0\.3 on /));
  });

  it("template summary carries the stale-data statement and citations", () => {
    const c = buildReportContent(source());
    const t = templateSummary(c);
    expect(t).toContain("Latest usable imagery is 23 days old");
    expect(t).toMatch(/\[E\d+\]\./);
    expect(t.match(/Latest usable imagery is 23 days old/g)).toHaveLength(1);
    expect(t).toContain("1 of 3 images in the period were unusable for analysis (92% of AOI pixels masked as cloud)");
    expect(t).toContain("No model-estimated weather records are stored");
  });

  it("says imagery is missing and fabricates no imagery metrics when none exists", () => {
    const c = buildReportContent(source({ observations: [], latestValid: null, assets: [], models: [], runs: [] }));
    expect(c.data_currency.status).toBe("missing");
    expect(c.data_currency.statement).toMatch(/No usable imagery has been processed for this AOI/);
    expect(c.observations!.statement.status).toBe("missing");
    expect(c.observations!.latest).toBeNull();
    expect(c.findings.some((f) => /NDVI/.test(f.text))).toBe(false);
    expect(templateSummary(c)).toMatch(/No usable imagery has been processed/);
  });

  it("labels news as claims with independent-source counts by distinct domain", () => {
    const art = (id: string, domain: string, story: string) => ({
      article_id: id,
      story_key: story,
      category: "flood",
      location_match: "place_in_title",
      title: `Flooding near North Field (${id})`,
      domain,
      url: `https://${domain}/${id}`,
      provider_id: "gdelt",
      published_at: ago(2),
    });
    const c = buildReportContent(
      source({ report: { ...source().report, type: "aoi" }, sections: REPORT_SECTIONS.aoi, news: [art("a1", "x.com", "s1"), art("a2", "x.com", "s1"), art("a3", "y.org", "s1"), art("a4", "z.net", "s2")] }),
    );
    expect(c.news!.note).toMatch(/claims made by publishers/);
    expect(c.news!.stories.map((s) => [s.story_key, s.independent_sources])).toEqual([["s1", 2], ["s2", 1]]);
  });
});

describe("AI summary", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ORYN_AI_MODEL;
  });
  afterEach(() => {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  });

  it("parses citations strictly", () => {
    expect(citedIds("NDVI fell [E1, E3].")).toEqual(["E1", "E3"]);
    expect(citedIds("Limit [L2] and [E4]")).toEqual(["L2", "E4"]);
    expect(citedIds("no citation")).toEqual([]);
    expect(citedIds("odd [see E1]")).toBeNull();
    const ev = { E1: {}, L2: {} };
    expect(validateCitations([{ text: "ok [E1]" }, { text: "bad [E9]" }, { text: "none" }, { text: "lim [L2]" }], ev)).toEqual({
      kept: [
        { text: "ok [E1]", evidence_ids: ["E1"] },
        { text: "lim [L2]", evidence_ids: ["L2"] },
      ],
      dropped: 2,
    });
  });

  it("uses only the template when no API key is configured", async () => {
    const s = await summarizeReport(buildReportContent(source()));
    expect(s.method).toBe("template");
    expect(s.ai).toBeNull();
    expect(s.text).toBe(s.template);
  });

  it("sends only structured findings, requests structured output, and drops sentences citing unknown ids", async () => {
    const content = buildReportContent(source());
    const valid = content.findings[1]!.evidence_ids[0]!;
    const lim = content.limitations.general[0]!.id;
    const parse = vi.fn<SummaryClient["messages"]["parse"]>(async () => ({
      stop_reason: "end_turn" as const,
      parsed_output: {
        sentences: [
          { text: `Usable imagery is 23 days old [${valid}].` },
          { text: "The crop is diseased [E999]." },
          { text: "Yields will fall." },
          { text: `This is a snapshot of stored data [${lim}].` },
        ],
      },
    }));
    const client: SummaryClient = { messages: { parse } };
    const s = await summarizeReport(content, { client });
    expect(s.method).toBe("ai:claude-opus-5-5");
    expect(s.ai!.sentences.map((x) => x.text)).toEqual([`Usable imagery is 23 days old [${valid}].`, `This is a snapshot of stored data [${lim}].`]);
    expect(s.ai!.dropped_sentences).toBe(2);
    expect(s.text).not.toMatch(/diseased|Yields/);
    expect(s.template).toContain("23 days old");

    const params = parse.mock.calls[0]![0];
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.max_tokens).toBe(16000);
    expect(params.output_config?.effort).toBe("low");
    expect(params.output_config?.format).toMatchObject({ type: "json_schema" });
    expect(params).not.toHaveProperty("thinking");
    expect(params.system).toBe(AI_SYSTEM_PROMPT);
    expect(params.messages).toHaveLength(1);
    const sent = JSON.parse(params.messages[0]!.content as string);
    expect(sent).toEqual(JSON.parse(JSON.stringify(aiInput(content))));
    expect(Object.keys(sent).sort()).toEqual(["data_currency", "evidence", "findings", "limitations", "period", "report_type", "subject"]);
    expect(JSON.stringify(sent)).not.toContain("org-1");
  });

  it("falls back to the template on refusal, API errors, and when nothing valid remains", async () => {
    const content = buildReportContent(source());
    const mk = (impl: () => Promise<{ stop_reason: Anthropic.StopReason | null; parsed_output?: unknown }>): SummaryClient => ({ messages: { parse: impl } });
    expect((await summarizeReport(content, { client: mk(async () => ({ stop_reason: "refusal", parsed_output: null })) })).method).toBe(
      "template (ai_unavailable: refusal)",
    );
    const rate = new Anthropic.RateLimitError(429, { type: "error" }, "rate limited", new Headers());
    expect((await summarizeReport(content, { client: mk(async () => Promise.reject(rate)) })).method).toBe("template (ai_unavailable: rate_limited)");
    const conn = new Anthropic.APIConnectionError({ message: "socket hang up" });
    expect((await summarizeReport(content, { client: mk(async () => Promise.reject(conn)) })).method).toBe("template (ai_unavailable: connection_error)");
    const bad = mk(async () => ({ stop_reason: "end_turn", parsed_output: { sentences: [{ text: "Unsupported claim [E999]." }] } }));
    const s = await summarizeReport(content, { client: bad });
    expect(s.method).toBe("template (ai_unavailable: no_valid_sentences)");
    expect(s.text).toBe(s.template);
    expect((await summarizeReport(content, { client: mk(async () => ({ stop_reason: "end_turn", parsed_output: null })) })).method).toBe(
      "template (ai_unavailable: invalid_output)",
    );
  });

  it("skips the AI call when the report opted out", async () => {
    const parse = vi.fn();
    const s = await summarizeReport(buildReportContent(source()), { ai: false, client: { messages: { parse } } });
    expect(s.method).toBe("template");
    expect(parse).not.toHaveBeenCalled();
  });
});

describe("PDF", () => {
  it("maps text to the WinAnsi set the built-in fonts can encode", () => {
    expect(pdfSafe("≥ 35 °C − ok → 10 m² “q” ✓")).toBe(">= 35 °C - ok -> 10 m² “q” ?");
  });

  it("renders with built-in Helvetica, including the raster preview and an empty-data variant", async () => {
    const c = buildReportContent(source());
    c.summary = { method: "template", template: templateSummary(c), ai: null, text: templateSummary(c) };
    const pdf = await renderReportPdf(c, { rasterPng: PNG_1PX });
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(3000);
    expect(pdf.toString("latin1")).toContain("/BaseFont /Helvetica");
    expect(pdf.toString("latin1")).not.toMatch(/FontFile2/); // no embedded external fonts

    const empty = buildReportContent(source({ observations: [], latestValid: null, weather: [], assets: [], models: [], runs: [] }));
    const pdf2 = await renderReportPdf(empty);
    expect(pdf2.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
