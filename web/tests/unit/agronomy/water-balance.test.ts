import { describe, expect, it } from "vitest";
import {
  CROP_PROFILES,
  dayOfYear,
  extraterrestrialRadiation,
  hargreavesEt0,
  kcOnDay,
  resolveCrop,
  simulateWaterBalance,
  SOIL_TEXTURES,
  textureAvailableWaterMmPerM,
  type CropProfile,
} from "@/lib/fao56";
import { computeWaterBalance, type Agronomy } from "@/server/agronomy/service";

describe("FAO-56 reference evapotranspiration", () => {
  it("reproduces FAO-56 Example 8: Ra at 20° S on 3 September is 32.2 MJ m⁻² day⁻¹", () => {
    expect(dayOfYear("2026-09-03")).toBe(246);
    expect(extraterrestrialRadiation(-20, 246)).toBeCloseTo(32.2, 1);
  });

  it("computes Hargreaves ETo (Eq. 52) from Tmax and Tmin", () => {
    // 0.0023 × (22.5 + 17.8) × √15 × (0.408 × 32.2) — worked by hand: ≈ 4.72 mm/day
    expect(hargreavesEt0(30, 15, -20, 246)!).toBeCloseTo(0.0023 * 40.3 * Math.sqrt(15) * 0.408 * 32.2, 1);
    expect(hargreavesEt0(10, 15, -20, 246)).toBeNull();
  });
});

describe("crop coefficient curve (FAO-56 Eq. 66, Tables 11 and 12)", () => {
  const soy = CROP_PROFILES.soybeans!; // 20 / 35 / 60 / 25 days; Kc 0.40 / 1.15 / 0.50
  it("is flat in the initial and mid stages and linear in between", () => {
    expect(kcOnDay(soy, soy.stages, 0)).toBe(0.4);
    expect(kcOnDay(soy, soy.stages, 19)).toBe(0.4);
    expect(kcOnDay(soy, soy.stages, 37)).toBeCloseTo(0.4 + (17 / 35) * 0.75, 10);
    expect(kcOnDay(soy, soy.stages, 55)).toBe(1.15);
    expect(kcOnDay(soy, soy.stages, 127)).toBeCloseTo(1.15 - (12 / 25) * 0.65, 10);
    expect(kcOnDay(soy, soy.stages, 140)).toBeNull();
  });

  it("uses the midpoint where Table 12 gives a range", () => {
    const cotton = CROP_PROFILES.cotton!;
    expect(kcOnDay(cotton, cotton.stages, 90)).toBeCloseTo(1.175, 10);
  });

  it("maps common crop names, and knows nothing it was not given", () => {
    expect(resolveCrop("Peanuts")?.id).toBe("groundnut");
    expect(resolveCrop("corn")?.id).toBe("maize_grain");
    expect(resolveCrop("quinoa")).toBeNull();
  });

  it("derives typical available water from Table 19 (mean θFC − mean θWP)", () => {
    expect(textureAvailableWaterMmPerM(SOIL_TEXTURES.loam!)).toBe(130); // (0.25 − 0.12) m³/m³
    expect(textureAvailableWaterMmPerM(SOIL_TEXTURES.sand!)).toBe(75); // (0.12 − 0.045)
  });
});

describe("daily root-zone water balance (FAO-56 Eq. 81–88)", () => {
  // A constant Kc of 1 for 100 days isolates the balance from the crop curve.
  const flat: CropProfile = { id: "flat", label: "Flat", kc: { ini: 1, mid: 1, end: 1 }, stages: { init: 100, dev: 1, mid: 1, late: 1 }, stagesRow: "test", rootDepthM: [1, 1], p: 0.5 };
  const days = (n: number, f: (i: number) => Partial<{ et0Mm: number; precipMm: number; irrigationMm: number }> = () => ({})) =>
    Array.from({ length: n }, (_, i) => ({ date: new Date(Date.UTC(2026, 4, 1 + i)).toISOString().slice(0, 10), et0Mm: 5, precipMm: 0, irrigationMm: 0, ...f(i) }));
  const params = { profile: flat, stages: flat.stages, plantingDate: "2026-05-01", availableWaterMmPerM: 50, rootDepthM: 1 };

  it("depletes by ETc, then reduces ETc with Ks once depletion passes RAW — worked by hand", () => {
    // TAW = 50 mm, ETc = 5 → p = 0.5 + 0.04 × 0 = 0.5 → RAW = 25 mm.
    const s = simulateWaterBalance(params, days(8));
    expect(s.map((d) => d.depletionMm).slice(0, 6)).toEqual([5, 10, 15, 20, 25, 30]);
    expect(s[0]!.tawMm).toBe(50);
    expect(s[0]!.rawMm).toBe(25);
    // Day 7 starts at 30 > 25: Ks = (50 − 30) / (0.5 × 50) = 0.8 → 4 mm → 34; day 8: Ks = 16 / 25 = 0.64 → 37.2.
    expect(s[6]!.ks).toBeCloseTo(0.8, 10);
    expect(s[6]!.depletionMm).toBeCloseTo(34, 10);
    expect(s[7]!.depletionMm).toBeCloseTo(37.2, 10);
  });

  it("refills with effective rain and irrigation, drains the excess, and ignores rain below 0.2 ETo", () => {
    // Day 1: 5; day 2: 10; day 3 rain 0.9 mm < 0.2 × 5 → ignored → 15; day 4 rain 30 mm → 15 − 30 + 5 = −10 → 0, 10 mm deep percolation;
    // day 5 irrigation 3 mm → 0 − 3 + 5 = 2.
    const s = simulateWaterBalance(params, days(5, (i) => (i === 2 ? { precipMm: 0.9 } : i === 3 ? { precipMm: 30 } : i === 4 ? { irrigationMm: 3 } : {})));
    expect(s.map((d) => d.depletionMm)).toEqual([5, 10, 15, 0, 2]);
    expect(s[2]!.effectivePrecipMm).toBe(0);
    expect(s[3]!.deepPercolationMm).toBe(10);
  });

  it("adjusts p for ETc and keeps it within 0.1–0.8", () => {
    const hot = simulateWaterBalance(params, days(1, () => ({ et0Mm: 12 })));
    expect(hot[0]!.p).toBeCloseTo(0.5 + 0.04 * (5 - 12), 10); // 0.22
    const cool = simulateWaterBalance(params, days(1, () => ({ et0Mm: 0.2 })));
    expect(cool[0]!.p).toBeCloseTo(0.5 + 0.04 * (5 - 0.2), 10); // 0.692
  });
});

describe("water balance outcomes", () => {
  const ag = (o: Partial<Agronomy> = {}): Agronomy => ({
    aoiId: "a",
    crop: "soybeans",
    cropSource: "agronomy",
    plantingDate: "2026-05-01",
    stageDays: null,
    soilTexture: "loam",
    availableWaterMmPerM: null,
    rootDepthM: null,
    notes: "",
    updatedAt: null,
    irrigation: [],
    ...o,
  });
  const point = { lat: 35.84, lon: -77.45 };
  const asOf = new Date("2026-05-11T12:00:00Z"); // estimate through 2026-05-10: 10 days
  const om = (variable: string, from: string, to: string, value: number) => {
    const out = [];
    for (let t = Date.parse(`${from}T04:00:00Z`); t <= Date.parse(`${to}T04:00:00Z`); t += 86_400_000) {
      out.push({ provider_id: "open-meteo", record_kind: "model_estimate", variable, value, valid_from: new Date(t), valid_to: new Date(t + 86_400_000) });
    }
    return out;
  };
  const allowAll = () => true;

  it("names each missing input instead of assuming it", async () => {
    const r = await computeWaterBalance(ag({ crop: null, plantingDate: null, soilTexture: null }), point, asOf, async () => [], allowAll);
    expect(r.status).toBe("insufficient_inputs");
    expect(r.missingInputs.map((m) => m.input)).toEqual(["crop", "planting date", "soil"]);
    expect(r.current).toBeNull();
    expect(r.series).toEqual([]);
  });

  it("refuses to estimate across a missing weather day, and lists it", async () => {
    const rows = [...om("et0_mm", "2026-05-01", "2026-05-10", 5), ...om("precipitation_mm", "2026-05-01", "2026-05-10", 0)].filter(
      (r) => !(r.variable === "precipitation_mm" && r.valid_from.toISOString().startsWith("2026-05-06")),
    );
    const r = await computeWaterBalance(ag(), point, asOf, async () => rows, allowAll);
    expect(r.status).toBe("insufficient_weather");
    expect(r.weather!.missingDates).toEqual(["2026-05-06"]);
    expect(r.current).toBeNull();
  });

  it("never uses a provider whose licence does not permit the use", async () => {
    const rows = [...om("et0_mm", "2026-05-01", "2026-05-10", 5), ...om("precipitation_mm", "2026-05-01", "2026-05-10", 0)];
    const r = await computeWaterBalance(ag(), point, asOf, async () => rows, () => false);
    expect(r.status).toBe("insufficient_weather");
    expect(r.weather!.et0).toBeNull();
    expect(r.statusText).toMatch(/non-commercial/);
  });

  it("estimates with the rooting-depth range as the uncertainty band, and says where every input came from", async () => {
    const rows = [...om("et0_mm", "2026-05-01", "2026-05-10", 5), ...om("precipitation_mm", "2026-05-01", "2026-05-10", 0)];
    const r = await computeWaterBalance(ag({ cropSource: "area_metadata" }), point, asOf, async () => rows, allowAll);
    expect(r.status).toBe("estimated");
    expect(r.throughDate).toBe("2026-05-10");
    // Soybeans in the initial stage: Kc 0.4 × 5 = 2 mm/day for 10 days.
    expect(r.current!.depletionMm).toBe(20);
    expect(r.current!.stage).toBe("initial");
    expect(r.current!.tawMm).toBe(Math.round(130 * 0.95 * 10) / 10); // loam 130 mm/m × Table 22 midpoint 0.95 m
    expect(r.current!.depletionRangeMm).toEqual([20, 20]); // below every TAW, the depth does not matter yet
    expect(r.inputs.crop!.source).toBe("Area metadata (crop field)");
    expect(r.inputs.availableWater!.source).toMatch(/Table 19/);
    expect(r.inputs.rootDepth!.range).toEqual([0.6, 1.3]);
    expect(r.weather!.et0!.licence).toMatch(/non-commercial/);
    expect(r.limitations.join(" ")).toMatch(/not a measurement/);
    expect(r.recommendation).toMatch(/soil-moisture reading/);
  });

  it("counts logged irrigation", async () => {
    const rows = [...om("et0_mm", "2026-05-01", "2026-05-10", 5), ...om("precipitation_mm", "2026-05-01", "2026-05-10", 0)];
    const r = await computeWaterBalance(ag({ irrigation: [{ id: "e", appliedOn: "2026-05-10", amountMm: 15, note: "", createdAt: "" }] }), point, asOf, async () => rows, allowAll);
    expect(r.current!.depletionMm).toBe(18 - 15 + 2); // 9 days × 2 mm, then −15 + 2 → 5
    expect(r.totals!.irrigationMm).toBe(15);
  });

  it("does not start before planting", async () => {
    const r = await computeWaterBalance(ag({ plantingDate: "2026-06-01" }), point, asOf, async () => [], allowAll);
    expect(r.status).toBe("not_started");
  });
});

describe("weather history window for a field's season", () => {
  it("reaches back to the planting date, never further than 400 days, and keeps 45 days otherwise", async () => {
    const { weatherHistoryStart } = await import("@/server/pipeline/context");
    const now = new Date("2026-10-18T12:00:00Z");
    expect(weatherHistoryStart(now, null).toISOString().slice(0, 10)).toBe("2026-09-03");
    expect(weatherHistoryStart(now, "2026-05-01").toISOString().slice(0, 10)).toBe("2026-05-01");
    expect(weatherHistoryStart(now, "2026-10-01").toISOString().slice(0, 10)).toBe("2026-09-03");
    expect(weatherHistoryStart(now, "2024-01-01").toISOString().slice(0, 10)).toBe("2025-09-13");
  });
});
