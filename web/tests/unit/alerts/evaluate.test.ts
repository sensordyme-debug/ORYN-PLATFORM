import { describe, expect, it } from "vitest";
import { ANALYTICS } from "@/server/analytics/registry";
import {
  dailySeries,
  evaluateRule,
  type EvalDetection,
  type EvalObservation,
  type EvalRule,
  type EvalWarning,
  type EvalWeather,
  type EvaluationData,
} from "@/server/alerts/evaluate";
import { parseRuleParams, RULE_TYPES, ruleCatalog, type RuleTypeId } from "@/server/alerts/rules";

const NOW = new Date("2026-10-15T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
let seq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function rule(ruleType: RuleTypeId, params: Record<string, unknown>, extra: Partial<EvalRule> = {}): EvalRule {
  return { id: "11111111-1111-4111-8111-111111111111", name: `Test ${ruleType}`, ruleType, params, severity: "high", createdAt: daysAgo(60), ...extra };
}

function data(over: Partial<EvaluationData> = {}): EvaluationData {
  return {
    now: NOW,
    aoi: { id: "22222222-2222-4222-8222-222222222222", name: "North Field", areaM2: 125_000, centroid: [-77.55, 35.9], createdAt: daysAgo(200) },
    observations: [],
    latestValidByKind: [],
    detections: [],
    weather: [],
    warnings: [],
    ...over,
  };
}

function ndvi(daysBack: number, mean: number, extra: Partial<EvalObservation> = {}): EvalObservation {
  return {
    id: uid(),
    kind: "ndvi",
    modelId: "ndvi",
    modelVersion: "1.0.0",
    resultClass: "deterministic_calculation",
    status: "valid",
    observedAt: daysAgo(daysBack),
    processedAt: daysAgo(daysBack - 0.5),
    ingestedAt: daysAgo(daysBack - 0.3),
    assetId: uid(),
    providerId: "earth-search",
    collection: "sentinel-2-l2a",
    platform: "sentinel-2a",
    metrics: { mean, median: mean, p10: mean - 0.1, p90: mean + 0.1, valid_fraction: 0.95 },
    quality: { coverage_fraction: 1, masked_fraction: 0.05, scene_cloud_cover: 3, flags: [], gsd_m: 10 },
    limitations: [],
    ...extra,
  };
}

function weather(dayStr: string, value: number, kind: EvalWeather["recordKind"] = "observation", extra: Partial<EvalWeather> = {}): EvalWeather {
  const from = new Date(`${dayStr}T00:00:00Z`);
  return {
    id: String(++seq),
    providerId: kind === "forecast" ? "open-meteo" : "noaa-ghcnd",
    recordKind: kind,
    variable: "precipitation_mm",
    value,
    unit: "mm",
    validFrom: from,
    validTo: new Date(from.getTime() + DAY),
    issuedAt: kind === "forecast" ? new Date("2026-10-15T06:00:00Z") : null,
    retrievedAt: new Date("2026-10-15T07:00:00Z"),
    stationId: kind === "observation" ? "USW0001" : null,
    stationDistanceKm: kind === "observation" ? 8.2 : null,
    ...extra,
  };
}

function detection(extra: Partial<EvalDetection> = {}): EvalDetection {
  return {
    id: uid(),
    type: "vegetation_loss",
    resultClass: "candidate_change",
    title: "Vegetation decrease",
    areaM2: 5_000,
    centroid: [-77.551, 35.901],
    evidenceGrade: "strong",
    evidenceReasons: ["same grid", "92% valid overlap"],
    verificationStatus: "unverified",
    modelId: "ndvi-change",
    modelVersion: "1.0.0",
    metrics: { direction: "decrease", mean_delta: -0.31 },
    baselineObservationId: uid(),
    comparisonObservationId: uid(),
    baselineObservedAt: daysAgo(12),
    comparisonObservedAt: daysAgo(2),
    lastObservedAt: daysAgo(2),
    sourceAssetIds: [uid(), uid()],
    limitations: [],
    createdAt: daysAgo(1),
    ingestedAt: daysAgo(1.5),
    ...extra,
  };
}

function expectCompleteExplanation(c: ReturnType<typeof evaluateRule>["candidates"][number]) {
  const e = c.explanation;
  for (const k of ["what", "where", "why", "certainty", "suggested_action"] as const) expect(e[k].length).toBeGreaterThan(10);
  expect(e.where).toContain("North Field");
  expect(e.evidence.length).toBeGreaterThan(0);
  for (const ev of e.evidence) {
    expect(ev.id).toBeTruthy();
    expect(ev.label).toBeTruthy();
    expect(["observation", "detection", "weather", "warning", "source_asset"]).toContain(ev.type);
    expect(ev).toHaveProperty("observed_at");
  }
  expect(e.limitations.length).toBeGreaterThan(0);
  expect(e.limitations).toContain(ANALYTICS["alert-rule"].limitations[0]);
  expect(e.rule.id).toBe(c.ruleId);
  expect(e.basis).toBeTruthy();
  expect(JSON.stringify(e)).not.toMatch(/confidence/i);
}

describe("rule catalog", () => {
  it("applies documented defaults and rejects unknown params", () => {
    expect(parseRuleParams("ndvi_drop_vs_baseline", {})).toEqual({ min_drop: 0.1, min_baseline_n: 3, baseline_days: 90 });
    expect(() => parseRuleParams("ndvi_below", {})).toThrow(/Invalid parameters/);
    expect(() => parseRuleParams("ndvi_drop_vs_baseline", { min_dropp: 0.2 })).toThrow();
    expect(parseRuleParams("precipitation_total_above", { window_days: 3, threshold_mm: 50, kinds: ["forecast"] }).kinds).toEqual(["forecast"]);
    expect(() => parseRuleParams("precipitation_total_above", { window_days: 3, threshold_mm: 50, kinds: ["forecast", "observation"] })).toThrow();
  });

  it("describes every rule type with label, schema, org kinds, and data needs", () => {
    for (const [id, def] of Object.entries(RULE_TYPES)) {
      expect(def.label, id).toBeTruthy();
      expect(def.needs, id).toBeTruthy();
      expect(def.orgKinds.length, id).toBeGreaterThan(0);
      expect(def.requires.length, id).toBeGreaterThan(0);
    }
    const catalog = ruleCatalog("municipal");
    expect(catalog.find((c) => c.type === "nws_warning")?.paramsSchema).toMatchObject({ type: "object" });
  });
});

describe("ndvi_drop_vs_baseline", () => {
  const r = rule("ndvi_drop_vs_baseline", { min_drop: 0.1, min_baseline_n: 3, baseline_days: 90 });

  it("fires on a real drop against the same-collection baseline, with a stable dedupe key", () => {
    const latest = ndvi(2, 0.55);
    const obs = [latest, ndvi(12, 0.71), ndvi(22, 0.69), ndvi(32, 0.7), ndvi(17, 0.2, { collection: "landsat-c2-l2" })];
    const d = data({ observations: obs });
    const out = evaluateRule(r, d);
    expect(out.notes).toEqual([]);
    expect(out.candidates).toHaveLength(1);
    const c = out.candidates[0]!;
    expect(c.dedupeKey).toBe(`ndvi_drop:${r.id}:${latest.id}`);
    expect(c.explanation.values.baseline_n).toBe(3);
    expect(c.explanation.values.baseline_mean as number).toBeCloseTo(0.7, 6);
    expect(c.explanation.values.drop as number).toBeCloseTo(0.15, 6);
    expect(c.observedAt).toEqual(latest.observedAt);
    expect(c.processedAt).toEqual(latest.processedAt);
    expect(c.eventAt).toBeNull();
    expect(c.imageryDerived).toBe(true);
    expect(c.explanation.limitations).toEqual(expect.arrayContaining([...ANALYTICS.ndvi.limitations]));
    expectCompleteExplanation(c);
    expect(evaluateRule(r, d).candidates[0]!.dedupeKey).toBe(c.dedupeKey);
  });

  it("produces no alert and an insufficient-data note when the baseline is too small", () => {
    const out = evaluateRule(r, data({ observations: [ndvi(2, 0.3), ndvi(12, 0.8), ndvi(22, 0.8), ndvi(17, 0.8, { collection: "landsat-c2-l2" })] }));
    expect(out.candidates).toEqual([]);
    expect(out.notes[0]).toMatchObject({ code: "insufficient_data", ruleId: r.id });
  });

  it("ignores unusable observations and baselines outside the window", () => {
    const obs = [ndvi(1, 0.2, { status: "unusable" }), ndvi(2, 0.69), ndvi(12, 0.71), ndvi(22, 0.7), ndvi(32, 0.7), ndvi(200, 0.95)];
    const out = evaluateRule(r, data({ observations: obs }));
    expect(out.candidates).toEqual([]);
    expect(out.notes[0]?.code).toBe("condition_not_met");
  });

  it("produces no alert without any NDVI data", () => {
    expect(evaluateRule(r, data())).toMatchObject({ candidates: [], notes: [{ code: "no_data" }] });
  });
});

describe("ndvi_below", () => {
  it("fires when the latest valid mean is below the threshold and explains with quality", () => {
    const latest = ndvi(3, 0.28);
    const out = evaluateRule(rule("ndvi_below", { threshold: 0.35 }), data({ observations: [latest, ndvi(13, 0.6)] }));
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]!.title).toContain("0.28");
    expect(out.candidates[0]!.explanation.certainty).toContain("95% of AOI pixels were usable");
    expectCompleteExplanation(out.candidates[0]!);
  });

  it("does not fire above the threshold", () => {
    expect(evaluateRule(rule("ndvi_below", { threshold: 0.35 }), data({ observations: [ndvi(3, 0.5)] })).candidates).toEqual([]);
  });

  it("records invalid stored params as a note, not an alert", () => {
    expect(evaluateRule(rule("ndvi_below", { threshold: "low" }), data({ observations: [ndvi(3, 0.1)] }))).toMatchObject({
      candidates: [],
      notes: [{ code: "invalid_params" }],
    });
  });
});

describe("detection_created", () => {
  const r = rule("detection_created", { types: [], min_area_m2: 1000, min_evidence_grade: "moderate" });

  it("fires once per matching new detection with the detection geometry", () => {
    const d1 = detection();
    const out = evaluateRule(r, data({ detections: [d1, detection({ evidenceGrade: "weak" }), detection({ areaM2: 400 }), detection({ verificationStatus: "dismissed" })] }));
    expect(out.candidates).toHaveLength(1);
    const c = out.candidates[0]!;
    expect(c.dedupeKey).toBe(`detection:${r.id}:${d1.id}`);
    expect(c.geom).toEqual({ source: "detection", detectionId: d1.id });
    expect(c.explanation.basis).toBe("candidate_change");
    expect(c.explanation.certainty).toMatch(/candidate change, not a confirmed/);
    expect(c.explanation.certainty).toMatch(/strong/);
    expect(c.explanation.evidence.map((e) => e.type)).toEqual(expect.arrayContaining(["detection", "observation", "source_asset"]));
    expect(c.explanation.limitations).toEqual(expect.arrayContaining([...ANALYTICS["ndvi-change"].limitations]));
    expect(c.observedAt).toEqual(d1.comparisonObservedAt);
    expectCompleteExplanation(c);
  });

  it("ignores detections recorded before the rule existed and filters by type", () => {
    const out = evaluateRule(
      rule("detection_created", { types: ["new_structure"] }),
      data({ detections: [detection({ createdAt: daysAgo(90) }), detection({ type: "vegetation_loss" })] }),
    );
    expect(out.candidates).toEqual([]);
  });
});

describe("precipitation_total_above", () => {
  const days = ["2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"];

  it("fires on recorded totals and prefers observations over model estimates for the same day", () => {
    const recs = [
      ...days.map((d, i) => weather(d, [10, 20, 15, 18][i]!)),
      ...days.map((d) => weather(d, 40, "model_estimate", { providerId: "era5" })),
    ];
    const r = rule("precipitation_total_above", { window_days: 4, threshold_mm: 50 });
    const out = evaluateRule(r, data({ weather: recs }));
    expect(out.candidates).toHaveLength(1);
    const c = out.candidates[0]!;
    expect(c.explanation.values.total_mm).toBe(63);
    expect(c.explanation.basis).toBe("observation");
    expect(c.title).toMatch(/^Observed precipitation 63 mm/);
    expect(c.title).not.toMatch(/forecast/i);
    expect(c.dedupeKey).toBe(`precip:${r.id}:${data().aoi.id}:2026-10-14`);
    expect(c.observedAt).toEqual(new Date("2026-10-15T00:00:00Z"));
    expect(c.explanation.evidence).toHaveLength(4);
    expectCompleteExplanation(c);
  });

  it("returns insufficient data when days are missing and the partial total is below the threshold", () => {
    const out = evaluateRule(rule("precipitation_total_above", { window_days: 4, threshold_mm: 50 }), data({ weather: [weather("2026-10-12", 10), weather("2026-10-14", 12)] }));
    expect(out).toMatchObject({ candidates: [], notes: [{ code: "insufficient_data" }] });
  });

  it("fires on a partial window when the available total already exceeds the threshold", () => {
    const out = evaluateRule(rule("precipitation_total_above", { window_days: 4, threshold_mm: 50 }), data({ weather: [weather("2026-10-12", 30), weather("2026-10-14", 31)] }));
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]!.explanation.why).toMatch(/can only be higher/);
  });

  it("labels forecast-based alerts as forecasts in title and explanation", () => {
    const recs = ["2026-10-15", "2026-10-16", "2026-10-17"].map((d) => weather(d, 30, "forecast"));
    recs.push(weather("2026-10-14", 99, "observation"));
    const r = rule("precipitation_total_above", { window_days: 3, threshold_mm: 60, kinds: ["forecast"] });
    const out = evaluateRule(r, data({ weather: recs }));
    expect(out.candidates).toHaveLength(1);
    const c = out.candidates[0]!;
    expect(c.title).toMatch(/^Forecast:/);
    expect(c.explanation.what).toMatch(/forecast/i);
    expect(c.explanation.what).toMatch(/not an observation/);
    expect(c.explanation.basis).toBe("forecast");
    expect(c.explanation.values.total_mm).toBe(90);
    expect(c.observedAt).toEqual(new Date("2026-10-15T06:00:00Z")); // issued time, not a future date
    expect(c.dedupeKey).toBe(`precip:${r.id}:${data().aoi.id}:forecast:2026-10-17`);
    expectCompleteExplanation(c);
  });
});

describe("dailySeries", () => {
  it("sums complete hourly records and drops incomplete days", () => {
    const hourly: EvalWeather[] = [];
    for (let h = 0; h < 24; h++) {
      const from = new Date(Date.UTC(2026, 9, 10, h));
      hourly.push(weather("2026-10-10", 0.5, "observation", { validFrom: from, validTo: new Date(from.getTime() + 3_600_000) }));
    }
    for (let h = 0; h < 6; h++) {
      const from = new Date(Date.UTC(2026, 9, 11, h));
      hourly.push(weather("2026-10-11", 1, "observation", { validFrom: from, validTo: new Date(from.getTime() + 3_600_000) }));
    }
    const s = dailySeries(hourly, "precipitation_mm", ["observation"], "sum");
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ day: "2026-10-10", value: 12, resolution: "subdaily" });
    expect(s[0]!.recordIds).toHaveLength(24);
  });
});

describe("dry_spell", () => {
  it("fires for a run of dry days and keys the alert by the spell start", () => {
    const recs = Array.from({ length: 12 }, (_, i) => weather(new Date(Date.UTC(2026, 9, 3 + i)).toISOString().slice(0, 10), i < 2 ? 8 : 0.2));
    const r = rule("dry_spell", { days: 7, max_daily_mm: 1 });
    const out = evaluateRule(r, data({ weather: recs }));
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]!.explanation.values.spell_days).toBe(10);
    expect(out.candidates[0]!.dedupeKey).toBe(`dry_spell:${r.id}:${data().aoi.id}:2026-10-05`);
    expectCompleteExplanation(out.candidates[0]!);
  });

  it("never treats a missing day as dry", () => {
    const recs = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12"].map((d) => weather(d, 0));
    const out = evaluateRule(rule("dry_spell", { days: 5 }), data({ weather: recs }));
    expect(out.candidates).toEqual([]);
    expect(out.notes[0]?.code).toBe("insufficient_data");
  });
});

describe("heat_stress", () => {
  const temp = (d: string, v: number, kind: EvalWeather["recordKind"]) => weather(d, v, kind, { variable: "temperature_max_c", unit: "°C" });

  it("fires on observed consecutive hot days", () => {
    const recs = [temp("2026-10-11", 31, "observation"), temp("2026-10-12", 36, "observation"), temp("2026-10-13", 37, "observation"), temp("2026-10-14", 35.5, "observation")];
    const out = evaluateRule(rule("heat_stress", { threshold_c: 35, consecutive_days: 3, kind: "observation" }), data({ weather: recs }));
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]!.title).toMatch(/^Heat stress: 3 day/);
    expect(out.candidates[0]!.explanation.values.peak_c).toBe(37);
  });

  it("labels forecast heat as a forecast and ignores other kinds", () => {
    const recs = [temp("2026-10-16", 38, "forecast"), temp("2026-10-17", 39, "forecast"), temp("2026-10-13", 45, "observation")];
    const out = evaluateRule(rule("heat_stress", { threshold_c: 35, consecutive_days: 2, kind: "forecast" }), data({ weather: recs }));
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]!.title).toMatch(/^Forecast: heat stress/);
    expect(out.candidates[0]!.explanation.what).toMatch(/forecast/);
    expect(out.candidates[0]!.explanation.basis).toBe("forecast");
  });
});

describe("nws_warning", () => {
  const w = (severity: string, extra: Partial<EvalWarning> = {}): EvalWarning => ({
    id: uid(),
    providerId: "nws",
    title: `${severity} Flood Warning`,
    severity,
    certainty: "Likely",
    urgency: "Expected",
    category: "Met",
    eventStart: new Date("2026-10-15T18:00:00Z"),
    eventEnd: new Date("2026-10-16T18:00:00Z"),
    publishedAt: new Date("2026-10-15T10:00:00Z"),
    retrievedAt: new Date("2026-10-15T10:05:00Z"),
    sourceUrl: "https://api.weather.gov/alerts/x",
    claimStatus: "official_warning",
    ...extra,
  });

  it("fires per active warning at or above the minimum severity with the onset as event time", () => {
    const severe = w("Severe");
    const out = evaluateRule(rule("nws_warning", { min_severity: "Severe" }), data({ warnings: [severe, w("Moderate"), w("Extreme", { eventEnd: daysAgo(1) })] }));
    expect(out.candidates).toHaveLength(1);
    const c = out.candidates[0]!;
    expect(c.eventAt).toEqual(severe.eventStart);
    expect(c.observedAt).toEqual(severe.publishedAt);
    expect(c.explanation.basis).toBe("official_warning");
    expect(c.explanation.what).toMatch(/not an ORYN observation or forecast/);
    expect(c.dedupeKey).toBe(`warning:${rule("nws_warning", {}).id}:${severe.id}`);
    expectCompleteExplanation(c);
  });
});

describe("new_water_area", () => {
  const water = (daysBack: number, area: number, extra: Partial<EvalObservation> = {}) =>
    ndvi(daysBack, 0, { kind: "ndwi", modelId: "ndwi", metrics: { water_area_m2: area, water_fraction: area / 125_000, valid_fraction: 0.93 }, ...extra });

  it("fires from water-change detections", () => {
    const d = detection({ type: "new_water", modelId: "water-change", metrics: { direction: "new_water" }, areaM2: 8_000 });
    const out = evaluateRule(rule("new_water_area", { min_area_m2: 5_000 }), data({ detections: [d] }));
    expect(out.candidates.map((c) => c.dedupeKey)).toEqual([`new_water:${rule("new_water_area", {}).id}:${d.id}`]);
    expect(out.candidates[0]!.explanation.limitations).toEqual(expect.arrayContaining([...ANALYTICS["water-change"].limitations]));
  });

  it("fires from an increase between two valid observations of the same product", () => {
    const latest = water(2, 12_000);
    const out = evaluateRule(rule("new_water_area", { min_area_m2: 5_000 }), data({ observations: [latest, water(12, 4_000)] }));
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]!.dedupeKey).toBe(`water_increase:${rule("new_water_area", {}).id}:${latest.id}`);
    expect(out.candidates[0]!.explanation.values.increase_m2).toBe(8_000);
  });

  it("does not compare areas when too few pixels were valid", () => {
    const out = evaluateRule(
      rule("new_water_area", { min_area_m2: 5_000 }),
      data({ observations: [water(2, 12_000, { metrics: { water_area_m2: 12_000, valid_fraction: 0.4 } }), water(12, 4_000)] }),
    );
    expect(out).toMatchObject({ candidates: [], notes: [{ code: "insufficient_data" }] });
  });
});

describe("stale_observations", () => {
  it("fires as a data-gap alert keyed by the last usable observation", () => {
    const latest = ndvi(23, 0.6);
    const cloudy = ndvi(5, 0, { status: "unusable", quality: { unusable_reason: "98% of AOI pixels masked as cloud", flags: [], coverage_fraction: 1, masked_fraction: 0.98, scene_cloud_cover: 90, gsd_m: 10 } });
    const r = rule("stale_observations", { max_age_days: 14 });
    const out = evaluateRule(r, data({ latestValidByKind: [latest], observations: [cloudy, latest] }));
    expect(out.candidates).toHaveLength(1);
    const c = out.candidates[0]!;
    expect(c.title).toBe("Data gap: no usable imagery for 23 days at North Field");
    expect(c.explanation.what).toMatch(/data-gap alert, not a report of a field condition/);
    expect(c.explanation.what).toMatch(/1 newer acquisition\(s\) were processed but unusable \(98% of AOI pixels masked as cloud\)/);
    expect(c.explanation.basis).toBe("data_gap");
    expect(c.dedupeKey).toBe(`stale:${r.id}:${data().aoi.id}:${latest.id}`);
    expect(c.imageryDerived).toBe(false);
    expectCompleteExplanation(c);
  });

  it("does not fire when recent data exists or the AOI is younger than the window", () => {
    expect(evaluateRule(rule("stale_observations", { max_age_days: 14 }), data({ latestValidByKind: [ndvi(3, 0.6)] })).candidates).toEqual([]);
    const young = data({ aoi: { ...data().aoi, createdAt: daysAgo(3) } });
    expect(evaluateRule(rule("stale_observations", { max_age_days: 14 }), young).candidates).toEqual([]);
  });
});
