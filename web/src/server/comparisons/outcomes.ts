/**
 * Every way a season comparison can end, with the statement shown in the
 * app and the report. "Nothing to show" outcomes are results, not errors:
 * each says what was looked at and why no comparison was made.
 */
export const OUTCOMES = [
  "changes_found",
  "no_change_above_threshold",
  "no_imagery_baseline",
  "no_imagery_comparison",
  "cloud_cover_baseline",
  "cloud_cover_comparison",
  "incompatible_tiles",
  "insufficient_overlap",
  "not_configured",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const OUTCOME_LABEL: Record<Outcome, string> = {
  changes_found: "Candidate changes found",
  no_change_above_threshold: "No change above the detection threshold",
  no_imagery_baseline: "No imagery in the baseline period",
  no_imagery_comparison: "No imagery in the comparison period",
  cloud_cover_baseline: "No usable image in the baseline period (cloud)",
  cloud_cover_comparison: "No usable image in the comparison period (cloud)",
  incompatible_tiles: "No image pair on the same tile and grid",
  insufficient_overlap: "Too little area clear in both images",
  not_configured: "This area is not set up for the comparison",
};

/** Outcomes where no comparison could be made at all. */
export const NOT_COMPARED: ReadonlySet<Outcome> = new Set<Outcome>([
  "no_imagery_baseline",
  "no_imagery_comparison",
  "cloud_cover_baseline",
  "cloud_cover_comparison",
  "incompatible_tiles",
  "insufficient_overlap",
  "not_configured",
]);
