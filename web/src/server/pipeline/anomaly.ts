/**
 * ndvi-anomaly 1.1.0 — the latest AOI-mean NDVI as a standard score against
 * the AOI's own earlier usable observations from the same collection.
 *
 * Baseline (selectBaseline):
 *  - samples are per acquisition date (UTC): observations of one pass over
 *    neighbouring tiles are averaged, weighted by valid pixels, into one
 *    sample, so a pass is never counted twice;
 *  - the observation's own date (±1 day) is never part of its baseline;
 *  - seasonal window: dates at least 300 days earlier whose time of year is
 *    within ±30 days, measured on a circle (late December and early January
 *    are 2–10 days apart, not 350);
 *  - if fewer than 3 seasonal dates exist: the 90 days before the observation.
 * With fewer than 3 baseline dates, or no variation, the result is stored as
 * 'unusable' with the reason — no score is invented.
 */
import { ANALYTICS } from "@/server/analytics/registry";
import { env } from "@/server/config/env";
import { jsonb, type Tx } from "@/server/db/client";

const MIN_BASELINE = 3;
const DAY_MS = 86_400_000;
const YEAR_DAYS = 365.2425;
const SEASON_HALF_WIDTH_DAYS = 30;
const SEASONAL_MIN_AGE_DAYS = 300;
const RECENT_WINDOW_DAYS = 90;
const SAME_PASS_DAYS = 1;

export function zScore(value: number, baseline: number[]): { z: number; mean: number; std: number } | null {
  if (baseline.length < MIN_BASELINE) return null;
  const mean = baseline.reduce((a, b) => a + b, 0) / baseline.length;
  const variance = baseline.reduce((a, b) => a + (b - mean) ** 2, 0) / (baseline.length - 1);
  const std = Math.sqrt(variance);
  if (!(std > 1e-6)) return null;
  return { z: (value - mean) / std, mean, std };
}

/** Distance between the times of year of two instants, in days, on a circle (0 … ~182.6). */
export function seasonalDistanceDays(a: Date, b: Date): number {
  const d = (((b.getTime() - a.getTime()) / DAY_MS) % YEAR_DAYS + YEAR_DAYS) % YEAR_DAYS;
  return Math.min(d, YEAR_DAYS - d);
}

export type BaselineCandidate = { mean: number; observedAt: Date; validPixels: number | null };
export type BaselineSample = { date: string; mean: number; observations: number };
export type Baseline = { window: "seasonal" | "recent"; label: string; samples: BaselineSample[] };

/** One sample per UTC acquisition date: valid-pixel-weighted mean of that date's observations. */
export function perAcquisitionDate(candidates: BaselineCandidate[]): (BaselineSample & { at: Date })[] {
  const byDate = new Map<string, { sum: number; weight: number; n: number; at: Date }>();
  for (const c of candidates) {
    if (!Number.isFinite(c.mean)) continue;
    const date = c.observedAt.toISOString().slice(0, 10);
    const w = c.validPixels && c.validPixels > 0 ? c.validPixels : 1;
    const e = byDate.get(date) ?? { sum: 0, weight: 0, n: 0, at: c.observedAt };
    e.sum += c.mean * w;
    e.weight += w;
    e.n += 1;
    byDate.set(date, e);
  }
  return [...byDate.entries()]
    .map(([date, e]) => ({ date, mean: e.sum / e.weight, observations: e.n, at: e.at }))
    .sort((x, y) => x.date.localeCompare(y.date));
}

export function selectBaseline(observedAt: Date, candidates: BaselineCandidate[]): Baseline {
  const t = observedAt.getTime();
  const earlier = perAcquisitionDate(candidates.filter((c) => c.observedAt.getTime() < t - SAME_PASS_DAYS * DAY_MS));
  const seasonal = earlier.filter(
    (s) => t - s.at.getTime() >= SEASONAL_MIN_AGE_DAYS * DAY_MS && seasonalDistanceDays(s.at, observedAt) <= SEASON_HALF_WIDTH_DAYS,
  );
  const strip = (xs: (BaselineSample & { at: Date })[]): BaselineSample[] => xs.map((x) => ({ date: x.date, mean: x.mean, observations: x.observations }));
  if (seasonal.length >= MIN_BASELINE) {
    return { window: "seasonal", label: `same season, earlier years (±${SEASON_HALF_WIDTH_DAYS} days)`, samples: strip(seasonal) };
  }
  const recent = earlier.filter((s) => t - s.at.getTime() <= RECENT_WINDOW_DAYS * DAY_MS);
  return { window: "recent", label: `previous ${RECENT_WINDOW_DAYS} days`, samples: strip(recent) };
}

export async function computeNdviAnomaly(tx: Tx, p: { orgId: string; aoiId: string; observationId: string; jobId: string | null }) {
  const model = ANALYTICS["ndvi-anomaly"];
  const [obs] = await tx<{ asset_id: string; mean: number | null; observed_at: Date; collection: string }[]>`
    select o.asset_id, (o.metrics->>'mean')::float8 as mean, o.observed_at, s.collection
      from observations o join source_assets s on s.id = o.asset_id
     where o.id = ${p.observationId} and o.org_id = ${p.orgId} and o.kind = 'ndvi' and o.status = 'valid'`;
  if (!obs || obs.mean === null) return null;

  // Every earlier usable observation of the same sensor family (bounded to ~6 seasons).
  const candidates = await tx<{ mean: number; observed_at: Date; valid_pixels: number | null }[]>`
    select (o.metrics->>'mean')::float8 as mean, o.observed_at, (o.metrics->>'valid_pixels')::int as valid_pixels
      from observations o join source_assets s on s.id = o.asset_id
     where o.aoi_id = ${p.aoiId} and o.kind = 'ndvi' and o.status = 'valid' and o.is_current and s.collection = ${obs.collection}
       and o.observed_at < ${obs.observed_at} and o.observed_at >= ${obs.observed_at}::timestamptz - interval '6 years'`;
  const baseline = selectBaseline(
    obs.observed_at,
    candidates.map((c) => ({ mean: c.mean, observedAt: c.observed_at, validPixels: c.valid_pixels })),
  );
  const r = zScore(obs.mean, baseline.samples.map((b) => b.mean));
  const status = r ? "valid" : "unusable";
  const n = baseline.samples.length;
  const reason = r
    ? null
    : n < MIN_BASELINE
      ? `Insufficient baseline: ${n} earlier usable acquisition date${n === 1 ? "" : "s"} (at least ${MIN_BASELINE} needed).`
      : "The baseline observations have no measurable variation.";
  const metrics = r
    ? { z_score: r.z, value: obs.mean, baseline_mean: r.mean, baseline_std: r.std, baseline_n: n, baseline_window: baseline.label, baseline_dates: baseline.samples.map((s) => s.date) }
    : { value: obs.mean, baseline_n: n, baseline_window: baseline.label, baseline_dates: baseline.samples.map((s) => s.date) };

  const [run] = await tx<{ id: string }[]>`
    insert into processing_runs (org_id, aoi_id, job_id, model_id, model_version, status, input_asset_ids, parameters, outputs, messages, software_version, finished_at)
    values (${p.orgId}, ${p.aoiId}, ${p.jobId}, ${model.id}, ${model.version}, ${r ? "succeeded" : "insufficient_data"}, ${[obs.asset_id]}::uuid[],
            ${jsonb({ observation_id: p.observationId, min_baseline: MIN_BASELINE, season_half_width_days: SEASON_HALF_WIDTH_DAYS, recent_window_days: RECENT_WINDOW_DAYS })}::jsonb,
            ${jsonb(metrics)}::jsonb, ${reason ? [reason] : []}, ${env.appVersion()}, now())
    returning id`;
  await tx`
    insert into observations (org_id, aoi_id, run_id, asset_id, model_id, model_version, kind, result_class, observed_at, status, metrics, quality, limitations)
    values (${p.orgId}, ${p.aoiId}, ${run!.id}, ${obs.asset_id}, ${model.id}, ${model.version}, 'ndvi_anomaly', ${model.resultClass}, ${obs.observed_at},
            ${status}, ${jsonb(metrics)}::jsonb, ${jsonb({ ...(reason ? { unusable_reason: reason } : {}), source_observation_id: p.observationId })}::jsonb,
            ${model.limitations as unknown as string[]})
    on conflict (aoi_id, asset_id, model_id, model_version) do nothing`;
  return { status, metrics };
}
