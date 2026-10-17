import { describe, expect, it } from "vitest";
import { sensorLabel, sensorSeries, sensorsIn } from "@/lib/sensors";

type Obs = { id: string; observedAt: string; status: "valid" | "unusable"; asset: { collection: string }; metrics: Record<string, unknown>; quality: Record<string, unknown> };
const obs = (id: string, at: string, collection: string, valid = 0.9, status: "valid" | "unusable" = "valid"): Obs => ({
  id,
  observedAt: at,
  status,
  asset: { collection },
  metrics: status === "valid" ? { mean: 0.5, valid_fraction: valid } : {},
  quality: { valid_fraction: valid },
});

describe("sensor series", () => {
  const s2 = "sentinel-2-l2a";
  const ls = "landsat-c2-l2";

  it("never mixes collections in one series", () => {
    const all = [obs("a", "2026-09-01T16:00:00Z", s2), obs("b", "2026-09-03T15:50:00Z", ls), obs("c", "2026-09-06T16:00:00Z", s2)];
    expect(sensorSeries(all, s2).map((o) => o.id)).toEqual(["a", "c"]);
    expect(sensorSeries(all, ls).map((o) => o.id)).toEqual(["b"]);
  });

  it("keeps one observation per pass: the one with the largest usable share", () => {
    const all = [
      obs("tile-1", "2026-09-01T16:00:05Z", s2, 0.4),
      obs("tile-2", "2026-09-01T16:00:09Z", s2, 0.95),
      obs("next", "2026-09-06T16:00:00Z", s2, 0.8),
    ];
    expect(sensorSeries(all, s2).map((o) => o.id)).toEqual(["tile-2", "next"]);
  });

  it("a valid image of a pass beats an unusable one", () => {
    const all = [obs("cloudy", "2026-09-01T16:00:05Z", s2, 0.05, "unusable"), obs("clear", "2026-09-01T16:00:09Z", s2, 0.3)];
    expect(sensorSeries(all, s2).map((o) => o.id)).toEqual(["clear"]);
  });

  it("lists sensors with the most recent valid one first", () => {
    const all = [obs("old-s2", "2026-08-01T16:00:00Z", s2), obs("new-ls", "2026-09-03T15:50:00Z", ls), obs("newest-cloudy-s2", "2026-09-06T16:00:00Z", s2, 0, "unusable")];
    expect(sensorsIn(all)).toEqual([ls, s2]);
  });

  it("labels known collections and passes others through", () => {
    expect(sensorLabel(s2)).toBe("Sentinel-2");
    expect(sensorLabel(ls)).toBe("Landsat");
    expect(sensorLabel("other")).toBe("other");
    expect(sensorLabel(null)).toBe("unknown sensor");
  });
});
