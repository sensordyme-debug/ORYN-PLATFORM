/**
 * Season-comparison periods: two date windows of the same area, a whole
 * number of years apart, starting within MAX_SEASON_OFFSET_DAYS of the same
 * calendar date.
 *
 * Comparing like-for-like seasons is the point of the feature: consecutive
 * images of a field differ mostly by growth stage, harvest, and weather. The
 * rule is checked here, before any imagery is requested, and stated to the
 * user when it fails.
 */
import { z } from "zod";
import { DomainError } from "@/server/errors";

const DAY_MS = 86_400_000;
const YEAR_DAYS = 365.25;

/** Longest window: about two Sentinel-2 revisit cycles a month apart is plenty. */
export const MAX_WINDOW_DAYS = 62;
/** The comparison window must start this close to the baseline start shifted by whole years. */
export const MAX_SEASON_OFFSET_DAYS = 31;
export const MAX_YEARS_APART = 10;
/** Sentinel-2 L2A coverage in the Earth Search catalog starts mid-2015. */
export const EARLIEST_DATE = "2015-07-01";

export type Window = { from: string; to: string };
export type ComparisonPeriods = { baseline: Window; comparison: Window; yearsApart: number; startOffsetDays: number };

const dateString = z.iso.date();
const windowSchema = z.strictObject({ from: dateString, to: dateString });
export const periodsSchema = z.strictObject({ baseline: windowSchema, comparison: windowSchema });

const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const days = (a: string, b: string) => Math.round((ms(b) - ms(a)) / DAY_MS);

/**
 * Validate two windows and return them with the year gap and seasonal start
 * offset. Throws a 422 DomainError naming each problem.
 */
export function validatePeriods(input: unknown, today: Date = new Date()): ComparisonPeriods {
  const parsed = periodsSchema.safeParse(input);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const i of parsed.error.issues) fields[i.path.join(".") || "input"] = i.message;
    throw new DomainError("invalid_periods", "Both periods need a start and end date (YYYY-MM-DD).", 422, fields);
  }
  const { baseline, comparison } = parsed.data;
  const todayStr = today.toISOString().slice(0, 10);
  const fields: Record<string, string> = {};
  for (const [name, w] of [["baseline", baseline], ["comparison", comparison]] as const) {
    if (ms(w.from) > ms(w.to)) fields[`${name}.to`] = "The end date is before the start date.";
    else if (days(w.from, w.to) + 1 > MAX_WINDOW_DAYS) fields[`${name}.to`] = `A period may span at most ${MAX_WINDOW_DAYS} days.`;
    if (ms(w.from) < ms(EARLIEST_DATE)) fields[`${name}.from`] = `Sentinel-2 L2A imagery is available from ${EARLIEST_DATE}.`;
    if (ms(w.to) > ms(todayStr)) fields[`${name}.to`] = "The period cannot end in the future.";
  }
  if (Object.keys(fields).length) throw new DomainError("invalid_periods", "The periods are invalid.", 422, fields);
  if (ms(baseline.to) >= ms(comparison.from)) {
    throw new DomainError("invalid_periods", "The baseline period must end before the comparison period starts.", 422, {
      "comparison.from": "Choose a later comparison period.",
    });
  }
  const gap = days(baseline.from, comparison.from);
  const yearsApart = Math.round(gap / YEAR_DAYS);
  const startOffsetDays = Math.round(gap - yearsApart * YEAR_DAYS) || 0;
  if (yearsApart < 1 || yearsApart > MAX_YEARS_APART || Math.abs(startOffsetDays) > MAX_SEASON_OFFSET_DAYS) {
    throw new DomainError(
      "not_seasonally_comparable",
      `The periods must cover the same season: the comparison period has to start within ${MAX_SEASON_OFFSET_DAYS} days of the baseline start date, 1 to ${MAX_YEARS_APART} years later. Comparing different seasons would mostly show seasonal growth and harvest.`,
      422,
      { "comparison.from": `Start between ${shift(baseline.from, 1, -MAX_SEASON_OFFSET_DAYS)} and ${shift(baseline.from, 1, MAX_SEASON_OFFSET_DAYS)} (one year later) or the same dates in a later year.` },
    );
  }
  return { baseline, comparison, yearsApart, startOffsetDays };
}

function shift(date: string, years: number, offsetDays: number): string {
  const d = new Date(ms(date));
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return new Date(d.getTime() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

/** The default suggestion: the last 45 days, and the same dates one year earlier. */
export function defaultPeriods(today: Date = new Date()): { baseline: Window; comparison: Window } {
  const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const from = new Date(to.getTime() - 44 * DAY_MS);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const comparison = { from: iso(from), to: iso(to) };
  return { baseline: { from: shift(comparison.from, -1, 0), to: shift(comparison.to, -1, 0) }, comparison };
}

/**
 * Days between two acquisitions in the season: the difference in day of year
 * after removing whole years (0 = same calendar day).
 */
export function seasonalOffsetDays(a: Date, b: Date): number {
  const gap = Math.abs(b.getTime() - a.getTime()) / DAY_MS;
  const years = Math.round(gap / YEAR_DAYS);
  return Math.round(Math.abs(gap - years * YEAR_DAYS));
}
