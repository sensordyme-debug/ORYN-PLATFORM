/**
 * ndvi-anomaly baseline selection and score: circular season window, one
 * sample per acquisition date, the observation's own pass excluded.
 */
import { describe, expect, it } from "vitest";
import { perAcquisitionDate, seasonalDistanceDays, selectBaseline, zScore, type BaselineCandidate } from "@/server/pipeline/anomaly";

const at = (iso: string) => new Date(iso);
const c = (iso: string, mean: number, validPixels: number | null = 100): BaselineCandidate => ({ observedAt: at(iso), mean, validPixels });

describe("ndvi-anomaly", () => {
  it("measures the season on a circle across the year boundary", () => {
    expect(seasonalDistanceDays(at("2025-12-28T16:00:00Z"), at("2026-01-05T16:00:00Z"))).toBeCloseTo(8, 5);
    expect(seasonalDistanceDays(at("2024-01-05T16:00:00Z"), at("2026-12-28T16:00:00Z"))).toBeLessThan(10);
    expect(seasonalDistanceDays(at("2025-07-01T00:00:00Z"), at("2026-01-01T00:00:00Z"))).toBeGreaterThan(170);
  });

  it("uses earlier years' same season, including across New Year", () => {
    const obs = at("2026-01-05T16:00:00Z");
    const b = selectBaseline(obs, [c("2023-12-30T16:00:00Z", 0.3), c("2024-12-27T16:00:00Z", 0.32), c("2025-01-10T16:00:00Z", 0.34), c("2025-06-01T16:00:00Z", 0.8)]);
    expect(b.window).toBe("seasonal");
    expect(b.samples.map((s) => s.date)).toEqual(["2023-12-30", "2024-12-27", "2025-01-10"]);
  });

  it("counts one pass over neighbouring tiles once, weighted by valid pixels", () => {
    const merged = perAcquisitionDate([c("2026-03-01T16:00:01Z", 0.6, 300), c("2026-03-01T16:00:04Z", 0.4, 100)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ date: "2026-03-01", observations: 2 });
    expect(merged[0]!.mean).toBeCloseTo(0.55, 10);
  });

  it("never puts the observation's own pass in its baseline (recent window)", () => {
    const obs = at("2026-06-10T16:00:05Z");
    const b = selectBaseline(obs, [c("2026-06-10T16:00:01Z", 0.1), c("2026-05-01T16:00:00Z", 0.5), c("2026-05-11T16:00:00Z", 0.52), c("2026-05-21T16:00:00Z", 0.55)]);
    expect(b.window).toBe("recent");
    expect(b.samples.map((s) => s.date)).toEqual(["2026-05-01", "2026-05-11", "2026-05-21"]);
  });

  it("scores against at least 3 dates with variation, otherwise reports no score", () => {
    expect(zScore(0.4, [0.5, 0.52])).toBeNull();
    expect(zScore(0.4, [0.5, 0.5, 0.5])).toBeNull();
    const r = zScore(0.4, [0.5, 0.55, 0.6])!;
    expect(r.mean).toBeCloseTo(0.55, 10);
    expect(r.std).toBeCloseTo(0.05, 10);
    expect(r.z).toBeCloseTo(-3, 10);
  });
});
