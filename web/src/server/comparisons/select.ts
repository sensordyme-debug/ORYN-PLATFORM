/**
 * Choosing the two images of a season comparison. Pure; unit-tested.
 *
 * Both images must be usable Sentinel-2 L2A NDVI observations on the SAME tile
 * and pixel grid, so the comparison never resamples and never mixes
 * acquisition geometries. On each grid the comparison image is the clearest
 * (ties: the later one); the baseline is, among images within
 * CLEAR_TOLERANCE of the clearest baseline, the one closest in the season to
 * the comparison image (a few days of phenology matter more for NDVI than a
 * fraction of a percent of cloud). Across grids, the pair whose less-clear
 * image is clearest wins. Every image considered gets a recorded decision and
 * the reason for it.
 */
import type { Outcome } from "./outcomes";
import { seasonalOffsetDays } from "./periods";

/** Baseline images this close to the clearest one count as equally clear. */
export const CLEAR_TOLERANCE = 0.02;

export type Candidate = {
  observationId: string | null;
  assetId: string;
  externalId: string;
  acquiredAt: Date;
  gridCode: string | null;
  epsg: number | null;
  platform: string | null;
  /** "not_processed": the scene was found but not analysed (reason says why). */
  status: "valid" | "unusable" | "not_processed";
  /** Fraction of the area clear and covered in this image (0–1). */
  clearFraction: number | null;
  coverageFraction: number | null;
  sceneCloudCover: number | null;
  reason: string | null;
};

export type Decision = Omit<Candidate, "acquiredAt"> & { acquiredAt: string; decision: "chosen" | "not_chosen"; why: string };

export type Selection =
  | { ok: true; baseline: Candidate; comparison: Candidate; grid: { gridCode: string | null; epsg: number | null }; decisions: { baseline: Decision[]; comparison: Decision[] } }
  | { ok: false; outcome: Outcome; detail: string; decisions: { baseline: Decision[]; comparison: Decision[] } };

const pct = (f: number | null) => (f === null ? "unknown" : `${(Math.round(f * 1000) / 10).toFixed(1)}%`);
const daysText = (n: number | null) => `${n} day${n === 1 ? "" : "s"}`;
const gridKey = (c: Candidate) => `${c.gridCode ?? "?"}|${c.epsg ?? "?"}`;
const gridLabel = (c: Pick<Candidate, "gridCode" | "epsg">) => `tile ${c.gridCode ?? "unknown"} (EPSG:${c.epsg ?? "?"})`;
const usable = (c: Candidate) => c.status === "valid" && c.observationId !== null;
const clear = (c: Candidate) => c.clearFraction ?? 0;

function best(list: Candidate[], prefer: (a: Candidate, b: Candidate) => number): Candidate | null {
  return [...list].sort((a, b) => clear(b) - clear(a) || prefer(a, b))[0] ?? null;
}

export function selectPair(baseline: Candidate[], comparison: Candidate[]): Selection {
  const validB = baseline.filter(usable);
  const validC = comparison.filter(usable);
  const grids = new Set(validC.map(gridKey).filter((k) => validB.some((b) => gridKey(b) === k)));

  let pair: { b: Candidate; c: Candidate } | null = null;
  for (const key of grids) {
    const c = best(validC.filter((x) => gridKey(x) === key), (x, y) => y.acquiredAt.getTime() - x.acquiredAt.getTime());
    if (!c) continue;
    const onGrid = validB.filter((x) => gridKey(x) === key);
    const top = Math.max(...onGrid.map(clear));
    const offset = (x: Candidate) => seasonalOffsetDays(x.acquiredAt, c.acquiredAt);
    const b = [...onGrid.filter((x) => clear(x) >= top - CLEAR_TOLERANCE)].sort((x, y) => offset(x) - offset(y) || clear(y) - clear(x))[0];
    if (!b) continue;
    const score = Math.min(clear(b), clear(c));
    const prev = pair ? Math.min(clear(pair.b), clear(pair.c)) : -1;
    if (
      !pair ||
      score > prev ||
      (score === prev && clear(b) + clear(c) > clear(pair.b) + clear(pair.c)) ||
      (score === prev && clear(b) + clear(c) === clear(pair.b) + clear(pair.c) && c.acquiredAt > pair.c.acquiredAt)
    ) {
      pair = { b, c };
    }
  }

  const decide = (list: Candidate[], chosen: Candidate | null, seasonRef: Candidate | null = null): Decision[] =>
    [...list]
      .sort((a, b) => a.acquiredAt.getTime() - b.acquiredAt.getTime())
      .map((c) => {
        const base = { ...c, acquiredAt: c.acquiredAt.toISOString() };
        const season = (x: Candidate) => (seasonRef ? seasonalOffsetDays(x.acquiredAt, seasonRef.acquiredAt) : null);
        if (chosen && c.assetId === chosen.assetId) {
          const days = season(c);
          return {
            ...base,
            decision: "chosen" as const,
            why: `Chosen: ${pct(c.clearFraction)} of the area clear, ${gridLabel(c)}${days === null ? "" : `; ${daysText(days)} from the comparison image in the season`}.`,
          };
        }
        if (c.status === "not_processed") return { ...base, decision: "not_chosen" as const, why: `Not analysed: ${c.reason ?? "no reason recorded"}` };
        if (c.status === "unusable") return { ...base, decision: "not_chosen" as const, why: `Unusable: ${c.reason ?? "too few clear pixels over the area"}` };
        if (chosen && gridKey(c) !== gridKey(chosen)) {
          return { ...base, decision: "not_chosen" as const, why: `Usable, but on ${gridLabel(c)}; the comparison uses ${gridLabel(chosen)} so both images share one pixel grid.` };
        }
        if (chosen && seasonRef && clear(c) >= clear(chosen) - CLEAR_TOLERANCE) {
          return {
            ...base,
            decision: "not_chosen" as const,
            why: `Usable and about as clear (${pct(c.clearFraction)}), but ${daysText(season(c))} from the comparison image in the season; the chosen image is ${daysText(season(chosen))}.`,
          };
        }
        if (chosen) return { ...base, decision: "not_chosen" as const, why: `Usable, ${pct(c.clearFraction)} clear; the chosen image is clearer (${pct(chosen.clearFraction)}).` };
        return { ...base, decision: "not_chosen" as const, why: `Usable, ${pct(c.clearFraction)} clear, ${gridLabel(c)}; no comparable image in the other period.` };
      });

  if (pair) {
    return {
      ok: true,
      baseline: pair.b,
      comparison: pair.c,
      grid: { gridCode: pair.c.gridCode, epsg: pair.c.epsg },
      decisions: { baseline: decide(baseline, pair.b, pair.c), comparison: decide(comparison, pair.c) },
    };
  }
  const decisions = { baseline: decide(baseline, null), comparison: decide(comparison, null) };
  const missing = (list: Candidate[], valid: Candidate[], which: "baseline" | "comparison"): { outcome: Outcome; detail: string } | null => {
    if (valid.length) return null;
    if (list.length === 0) {
      return {
        outcome: which === "baseline" ? "no_imagery_baseline" : "no_imagery_comparison",
        detail: `No Sentinel-2 L2A image of this area was found in the ${which} period within the area's cloud limit.`,
      };
    }
    const reasons = [...new Set(list.map((c) => c.reason).filter((r): r is string => Boolean(r)))].slice(0, 3);
    return {
      outcome: which === "baseline" ? "cloud_cover_baseline" : "cloud_cover_comparison",
      detail: `${list.length} image(s) of the ${which} period were found, none usable over this area${reasons.length ? `: ${reasons.join("; ")}` : ""}.`,
    };
  };
  const first = missing(baseline, validB, "baseline") ?? missing(comparison, validC, "comparison");
  if (first) return { ok: false, ...first, decisions };
  const tiles = (list: Candidate[]) => [...new Set(list.map(gridLabel))].join(", ");
  return {
    ok: false,
    outcome: "incompatible_tiles",
    detail: `Usable images exist in both periods but never on the same tile and grid: baseline ${tiles(validB)}; comparison ${tiles(validC)}. Images on different grids are not compared.`,
    decisions,
  };
}
