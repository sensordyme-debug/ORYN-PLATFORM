/**
 * The comparison section of a change evidence report: one season comparison
 * frozen with its evidence — periods, the two images and every image
 * considered, method and thresholds, outcome, and each finding with its
 * evidence grade, reasons, review state and notes.
 *
 * The loader reads stored rows only; the builder is pure (unit-tested).
 */
import type { Tx } from "@/server/db/client";
import { readComparison, type ChosenImage, type ComparisonDetail } from "@/server/comparisons/service";
import { NOT_COMPARED, OUTCOME_LABEL, type Outcome } from "@/server/comparisons/outcomes";
import { ANALYTICS } from "@/server/analytics/registry";
import type { ComparisonConsidered, ComparisonFindingEntry, ComparisonImageEntry, ComparisonSection, EvidenceKind } from "./types";

/** Findings beyond this get a table row but no page of their own. */
export const MAX_FINDING_PAGES = 50;

export type ComparisonSource = ComparisonDetail & {
  notes: Record<string, { body: string; author: string | null; created_at: Date }[]>;
};

export async function loadComparisonForReport(tx: Tx, orgId: string, comparisonId: string): Promise<ComparisonSource | null> {
  const detail = await readComparison(tx, orgId, comparisonId, tx``);
  if (!detail) return null;
  const ids = detail.items.map((d) => d.id);
  const rows = ids.length
    ? await tx<{ target_id: string; body: string; author: string | null; created_at: Date }[]>`
        select n.target_id, n.body, u.name as author, n.created_at
          from notes n left join auth_user u on u.id = n.author_id
         where n.org_id = ${orgId} and n.target_type = 'detection' and n.target_id = any(${ids}::uuid[])
         order by n.created_at`
    : [];
  const notes: ComparisonSource["notes"] = {};
  for (const r of rows) (notes[r.target_id] ??= []).push({ body: r.body, author: r.author, created_at: r.created_at });
  return { ...detail, notes };
}

type AddEvidence = (kind: EvidenceKind, table: string | null, rowIds: string[], label: string) => string;
type AddFinding = (section: string, text: string, evidenceIds: string[]) => void;

const pct = (f: number | null | undefined) => (f === null || f === undefined ? "unknown" : `${Math.round(f * 100)}%`);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function buildComparisonSection(src: ComparisonSource, addEvidence: AddEvidence, addFinding: AddFinding): ComparisonSection {
  const outcome = (src.outcome ?? "not_configured") as Outcome;
  const model = ANALYTICS["ndvi-period-change"];
  const r = src.result ?? {};
  const eid = addEvidence("comparison", "comparisons", [src.id], `Season comparison ${src.baseline.from}–${src.baseline.to} vs ${src.comparison.from}–${src.comparison.to}`);

  const image = (role: "baseline" | "comparison", i: ChosenImage | null): ComparisonImageEntry | null =>
    i
      ? {
          evidence_id: addEvidence("observation", "observations", [i.observationId], `${role === "baseline" ? "Baseline" : "Comparison"} image ${i.externalId}`),
          role,
          observation_id: i.observationId,
          asset_id: i.assetId,
          external_id: i.externalId,
          platform: i.platform,
          acquired_at: i.acquiredAt.toISOString(),
          grid_code: i.gridCode,
          epsg: i.epsg,
          clear_fraction: i.clearFraction,
          coverage_fraction: i.coverageFraction,
          scene_cloud_cover: i.sceneCloudCover,
          license: i.license,
          attribution: i.attribution,
          stac_url: i.stacUrl,
          true_color_key: i.trueColorKey,
          corners: i.corners,
        }
      : null;
  const images = { baseline: image("baseline", src.images.baseline), comparison: image("comparison", src.images.comparison) };

  const considered = (list: NonNullable<ComparisonSource["selection"]["decisions"]>["baseline"] | undefined): ComparisonConsidered[] =>
    (list ?? []).map((d) => ({
      external_id: d.externalId,
      acquired_at: d.acquiredAt,
      platform: d.platform,
      grid_code: d.gridCode,
      status: d.status,
      clear_fraction: d.clearFraction,
      decision: d.decision,
      why: d.why,
    }));

  const findings: ComparisonFindingEntry[] = src.items.map((d) => ({
    evidence_id: addEvidence("detection", "detections", [d.id], d.title),
    detection_id: d.id,
    title: d.title,
    type: d.type,
    area_m2: d.areaM2,
    mean_delta: d.meanDelta,
    direction: d.direction,
    pixel_count: d.pixelCount,
    evidence_grade: d.evidenceGrade,
    evidence_reasons: d.evidenceReasons,
    verification_status: d.verificationStatus,
    centroid: d.centroid,
    bbox: d.bbox,
    geometry: d.geometry,
    notes: (src.notes[d.id] ?? []).map((n) => ({ body: n.body, author: n.author, created_at: n.created_at.toISOString() })),
  }));

  const compared = !NOT_COMPARED.has(outcome);
  const imageIds = [images.baseline?.evidence_id, images.comparison?.evidence_id].filter((x): x is string => Boolean(x));
  addFinding("comparison", `${OUTCOME_LABEL[outcome]}. ${src.outcomeDetail ?? ""}`.trim(), [eid, ...imageIds]);
  if (images.baseline && images.comparison) {
    addFinding(
      "comparison",
      `Compared ${images.baseline.external_id} (${images.baseline.acquired_at.slice(0, 10)}, ${pct(images.baseline.clear_fraction)} of the area clear) with ${images.comparison.external_id} (${images.comparison.acquired_at.slice(0, 10)}, ${pct(images.comparison.clear_fraction)} clear) on tile ${images.comparison.grid_code ?? "unknown"}.`,
      [eid, ...imageIds],
    );
  }
  const byGrade = (g: string) => findings.filter((f) => f.evidence_grade === g).length;
  if (findings.length) {
    addFinding(
      "comparison",
      `${findings.length} candidate change(s): ${byGrade("strong")} strong, ${byGrade("moderate")} moderate, ${byGrade("weak")} weak evidence; ${findings.filter((f) => f.verification_status === "unverified").length} not yet reviewed.`,
      [eid, ...findings.map((f) => f.evidence_id)],
    );
  }

  const deltaKey = typeof r.delta_png_key === "string" ? r.delta_png_key : null;
  const corners = Array.isArray(r.corners) ? (r.corners as ComparisonImageEntry["corners"]) : null;
  const statement = compared
    ? { status: "ok" as const, text: `The two periods were compared with ${model.name.toLowerCase()} (${model.id}@${model.version}).` }
    : { status: "missing" as const, text: `No comparison was made: ${src.outcomeDetail ?? OUTCOME_LABEL[outcome]}` };
  const notes = Object.values(src.selection.notes ?? {}).filter((n): n is string => Boolean(n));

  return {
    evidence_id: eid,
    comparison_id: src.id,
    statement,
    sensor: "Sentinel-2 L2A",
    provider: "Earth Search (Element 84), Copernicus Sentinel-2 data on AWS",
    periods: { baseline: src.baseline, comparison: src.comparison },
    outcome,
    outcome_label: OUTCOME_LABEL[outcome],
    outcome_detail: src.outcomeDetail ?? "",
    compared,
    method: {
      model_id: model.id,
      model_version: model.version,
      name: model.name,
      description: model.description,
      threshold: num(r.threshold) ?? 0.2,
      min_area_m2: num(r.min_area_m2) ?? 2000,
      min_overlap: num(r.min_overlap) ?? 0.3,
    },
    measurements:
      src.result === null
        ? null
        : {
            overlap: num(r.overlap),
            same_grid: typeof r.same_grid === "boolean" ? r.same_grid : null,
            days_between: num(r.days_between),
            seasonal_offset_days: num(r.seasonal_offset_days),
            coverage_fraction: num(r.coverage_fraction),
          },
    images,
    considered: { baseline: considered(src.selection.decisions?.baseline), comparison: considered(src.selection.decisions?.comparison) },
    notes,
    delta: deltaKey && corners ? { png_key: deltaKey, corners: corners as NonNullable<ComparisonImageEntry["corners"]> } : null,
    findings,
    findings_listed_only: Math.max(0, findings.length - MAX_FINDING_PAGES),
    run_id: null,
  };
}
