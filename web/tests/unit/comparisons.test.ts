import { describe, expect, it } from "vitest";
import { defaultPeriods, MAX_SEASON_OFFSET_DAYS, seasonalOffsetDays, validatePeriods } from "@/server/comparisons/periods";
import { selectPair, type Candidate } from "@/server/comparisons/select";
import { gradeEvidence } from "@/server/pipeline/change";

const TODAY = new Date("2026-10-17T12:00:00Z");
const ok = (b: [string, string], c: [string, string]) => validatePeriods({ baseline: { from: b[0], to: b[1] }, comparison: { from: c[0], to: c[1] } }, TODAY);

describe("season comparison periods", () => {
  it("accepts the same season one or more years apart", () => {
    expect(ok(["2025-09-01", "2025-09-30"], ["2026-09-01", "2026-09-30"])).toMatchObject({ yearsApart: 1, startOffsetDays: 0 });
    expect(ok(["2023-06-01", "2023-07-15"], ["2026-06-20", "2026-07-31"])).toMatchObject({ yearsApart: 3 });
  });

  it("rejects different seasons, with the allowed start dates", () => {
    expect(() => ok(["2026-03-01", "2026-03-31"], ["2026-09-01", "2026-09-30"])).toThrow(/same season/);
    expect(() => ok(["2025-03-01", "2025-03-31"], ["2026-09-01", "2026-09-30"])).toThrow(/same season/);
    try {
      ok(["2025-03-01", "2025-03-31"], ["2026-09-01", "2026-09-30"]);
    } catch (e) {
      expect((e as { status: number; code: string; fields: Record<string, string> }).status).toBe(422);
      expect((e as { code: string }).code).toBe("not_seasonally_comparable");
      expect((e as { fields: Record<string, string> }).fields["comparison.from"]).toMatch(/2026-01-29 and 2026-04-01/);
    }
  });

  it("rejects malformed, reversed, overlong, future and pre-archive periods", () => {
    expect(() => validatePeriods({ baseline: { from: "2025-09-01" }, comparison: { from: "2026-09-01", to: "2026-09-30" } }, TODAY)).toThrow(/start and end/);
    expect(() => ok(["2025-09-30", "2025-09-01"], ["2026-09-01", "2026-09-30"])).toThrow(/invalid/);
    expect(() => ok(["2025-07-01", "2025-09-30"], ["2026-07-01", "2026-09-30"])).toThrow(/invalid/);
    expect(() => ok(["2025-10-01", "2025-10-31"], ["2026-10-01", "2026-10-31"])).toThrow(/invalid/);
    expect(() => ok(["2014-09-01", "2014-09-30"], ["2016-09-01", "2016-09-30"])).toThrow(/invalid/);
    expect(() => ok(["2026-09-01", "2026-09-30"], ["2026-09-15", "2026-10-10"])).toThrow(/must end before/);
  });

  it(`allows a start offset up to ${MAX_SEASON_OFFSET_DAYS} days and measures seasonal offsets across years`, () => {
    expect(ok(["2025-09-01", "2025-09-30"], ["2026-10-01", "2026-10-15"]).startOffsetDays).toBeLessThanOrEqual(MAX_SEASON_OFFSET_DAYS);
    expect(seasonalOffsetDays(new Date("2025-09-12"), new Date("2026-09-14"))).toBe(2);
    expect(seasonalOffsetDays(new Date("2025-09-12"), new Date("2025-09-12"))).toBe(0);
  });

  it("suggests the last 45 days and the same dates one year earlier", () => {
    const d = defaultPeriods(TODAY);
    expect(d).toEqual({ baseline: { from: "2025-09-03", to: "2025-10-17" }, comparison: { from: "2026-09-03", to: "2026-10-17" } });
    expect(() => validatePeriods(d, TODAY)).not.toThrow();
  });
});

const cand = (o: Partial<Candidate> & { id: string; at: string }): Candidate => ({
  observationId: o.status === "not_processed" ? null : `obs-${o.id}`,
  assetId: `asset-${o.id}`,
  externalId: o.id,
  acquiredAt: new Date(o.at),
  gridCode: "MGRS-18STE",
  epsg: 32618,
  platform: "sentinel-2a",
  status: "valid",
  clearFraction: 0.9,
  coverageFraction: 1,
  sceneCloudCover: 5,
  reason: null,
  ...o,
});

describe("choosing the image pair", () => {
  it("takes the clearest usable pair on one grid and records every decision", () => {
    const b = [cand({ id: "B1", at: "2025-09-05", clearFraction: 0.6 }), cand({ id: "B2", at: "2025-09-15", clearFraction: 0.95 }), cand({ id: "B3", at: "2025-09-20", status: "unusable", clearFraction: 0.05, reason: "clouds" })];
    const c = [cand({ id: "C1", at: "2026-09-08", clearFraction: 0.8 }), cand({ id: "C2", at: "2026-09-18", status: "not_processed", reason: "scene cloud 80%" })];
    const s = selectPair(b, c);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect([s.baseline.externalId, s.comparison.externalId]).toEqual(["B2", "C1"]);
    expect(s.decisions.baseline.map((d) => [d.externalId, d.decision])).toEqual([["B1", "not_chosen"], ["B2", "chosen"], ["B3", "not_chosen"]]);
    expect(s.decisions.baseline.find((d) => d.externalId === "B3")!.why).toMatch(/^Unusable: clouds/);
    expect(s.decisions.comparison.find((d) => d.externalId === "C2")!.why).toMatch(/^Not analysed: scene cloud 80%/);
  });

  it("among equally clear baselines, takes the one closest in the season to the comparison image", () => {
    const s = selectPair(
      [
        cand({ id: "B-early", at: "2025-09-03", clearFraction: 0.998 }),
        cand({ id: "B-close", at: "2025-09-10", clearFraction: 0.985 }),
        cand({ id: "B-closest-but-cloudy", at: "2025-09-11", clearFraction: 0.9 }),
      ],
      [cand({ id: "C", at: "2026-09-11", clearFraction: 0.998 })],
    );
    expect(s.ok && s.baseline.externalId).toBe("B-close");
    if (!s.ok) return;
    const why = Object.fromEntries(s.decisions.baseline.map((d) => [d.externalId, d.why]));
    expect(why["B-close"]).toBe("Chosen: 98.5% of the area clear, tile MGRS-18STE (EPSG:32618); 1 day from the comparison image in the season.");
    expect(why["B-early"]).toBe("Usable and about as clear (99.8%), but 8 days from the comparison image in the season; the chosen image is 1 day.");
    expect(why["B-closest-but-cloudy"]).toBe("Usable, 90.0% clear; the chosen image is clearer (98.5%).");
  });

  it("never pairs images from different grids", () => {
    const s = selectPair([cand({ id: "B", at: "2025-09-05", gridCode: "MGRS-17SQV", epsg: 32617 })], [cand({ id: "C", at: "2026-09-05" })]);
    expect(s).toMatchObject({ ok: false, outcome: "incompatible_tiles" });
  });

  it("prefers a shared grid even when another tile has a clearer single image", () => {
    const s = selectPair(
      [cand({ id: "B-ste", at: "2025-09-05", clearFraction: 0.7 }), cand({ id: "B-sqv", at: "2025-09-06", gridCode: "MGRS-17SQV", epsg: 32617, clearFraction: 0.99 })],
      [cand({ id: "C-ste", at: "2026-09-05", clearFraction: 0.8 })],
    );
    expect(s.ok && [s.baseline.externalId, s.comparison.externalId]).toEqual(["B-ste", "C-ste"]);
  });

  it("names the missing or cloudy period", () => {
    expect(selectPair([], [cand({ id: "C", at: "2026-09-05" })])).toMatchObject({ ok: false, outcome: "no_imagery_baseline" });
    expect(selectPair([cand({ id: "B", at: "2025-09-05" })], [])).toMatchObject({ ok: false, outcome: "no_imagery_comparison" });
    const cloudy = selectPair([cand({ id: "B", at: "2025-09-05" })], [cand({ id: "C", at: "2026-09-05", status: "unusable", reason: "Only 4% of the area was cloud-free" })]);
    expect(cloudy).toMatchObject({ ok: false, outcome: "cloud_cover_comparison" });
    expect(!cloudy.ok && cloudy.detail).toMatch(/Only 4% of the area was cloud-free/);
  });
});

describe("evidence grading for season-matched images", () => {
  const base = { kind: "ndvi" as const, meanDelta: -0.5, threshold: 0.2, pixelCount: 100, overlap: 0.9, sameGrid: true, maskedBefore: 0, maskedAfter: 0 };
  it("grades on the seasonal offset, not the year between the images", () => {
    expect(gradeEvidence({ ...base, daysBetween: 367 }).grade).toBe("weak");
    const matched = gradeEvidence({ ...base, daysBetween: 367, seasonalOffsetDays: 2 });
    expect(matched.grade).toBe("strong");
    expect(matched.reasons.join(" ")).toMatch(/Season-matched: the images are 2 days apart in the season \(367 days apart in all\)/);
    expect(gradeEvidence({ ...base, daysBetween: 390, seasonalOffsetDays: 25 }).grade).toBe("moderate");
    expect(gradeEvidence({ ...base, daysBetween: 400, seasonalOffsetDays: 40 }).grade).toBe("weak");
  });
});
