"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, orgApi } from "@/components/map/api";
import { Badge, Button, inputClass, Notice } from "@/components/platform/ui";
import { formatArea } from "@/lib/geo";
import { formatDate } from "@/lib/format";
import { OUTCOME_LABEL, type Outcome } from "@/server/comparisons/outcomes";

/**
 * Season comparison for one area: compare the same season of two years with
 * Sentinel-2 (src/server/comparisons), review the candidate changes it finds,
 * and produce the change evidence report. Every outcome, including "nothing
 * to compare", is shown with its reason.
 */

type Period = { from: string; to: string };
type Summary = {
  id: string;
  baseline: Period;
  comparison: Period;
  status: "queued" | "searching" | "processing" | "comparing" | "done" | "failed";
  outcome: Outcome | null;
  outcomeDetail: string | null;
  findings: number;
  error: string | null;
  createdAt: string;
};
type Detail = Summary & {
  items: { id: string; title: string; evidenceGrade: string; verificationStatus: string; areaM2: number | null }[];
  images: { baseline: { externalId: string; acquiredAt: string } | null; comparison: { externalId: string; acquiredAt: string } | null };
};

const STEP: Record<Summary["status"], string> = {
  queued: "Queued",
  searching: "Searching the catalog",
  processing: "Analysing images",
  comparing: "Comparing",
  done: "Done",
  failed: "Failed",
};
const OUTCOME_TONE: Partial<Record<Outcome, "watch" | "good" | "alert">> = { changes_found: "watch", no_change_above_threshold: "good" };
const GRADE_TONE: Record<string, "good" | "watch" | "muted"> = { strong: "good", moderate: "watch", weak: "muted" };

const iso = (d: Date) => d.toISOString().slice(0, 10);
function defaultPeriods(): { baseline: Period; comparison: Period } {
  const today = new Date();
  const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const from = new Date(to.getTime() - 44 * 86_400_000);
  const lastYear = (d: Date) => new Date(Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), d.getUTCDate()));
  return { baseline: { from: iso(lastYear(from)), to: iso(lastYear(to)) }, comparison: { from: iso(from), to: iso(to) } };
}

export function ComparisonPanel({
  slug,
  aoiId,
  canRun,
  canReport,
  timeZone,
  onSelectDetection,
}: {
  slug: string;
  aoiId: string;
  canRun: boolean;
  canReport: boolean;
  timeZone: string;
  onSelectDetection: (id: string) => void;
}) {
  const [periods, setPeriods] = useState(defaultPeriods);
  const [items, setItems] = useState<Summary[] | null>(null);
  const [open, setOpen] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<{ comparisonId: string; reportId: string } | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ items: Summary[] }>(`${orgApi(slug)}/aois/${aoiId}/comparisons`);
    setItems(r.items);
    return r.items;
  }, [slug, aoiId]);

  const show = useCallback(
    async (id: string) => {
      setOpen(await api<Detail>(`${orgApi(slug)}/comparisons/${id}`));
    },
    [slug],
  );

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const list = await load();
        if (cancelled) return;
        if (list.some((c) => c.status !== "done" && c.status !== "failed")) timer = setTimeout(tick, 5000);
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : "Could not load comparisons.");
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  async function run() {
    setBusy(true);
    setError(null);
    setFields({});
    try {
      await api(`${orgApi(slug)}/aois/${aoiId}/comparisons`, { method: "POST", json: periods });
      const list = await load();
      // Keep polling while it runs.
      if (list.some((c) => c.status !== "done" && c.status !== "failed")) {
        const poll = async () => {
          const next = await load();
          if (next.some((c) => c.status !== "done" && c.status !== "failed")) setTimeout(poll, 5000);
        };
        setTimeout(poll, 5000);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not start the comparison.");
      if (e instanceof ApiError && e.fields) setFields(e.fields);
    } finally {
      setBusy(false);
    }
  }

  async function makeReport(comparisonId: string) {
    setError(null);
    try {
      const r = await api<{ id: string }>(`${orgApi(slug)}/reports`, { method: "POST", json: { type: "change_evidence", aoiId, params: { comparison_id: comparisonId } } });
      setReport({ comparisonId, reportId: r.id });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not create the report.");
    }
  }

  const dateInput = (label: string, which: "baseline" | "comparison", end: "from" | "to") => (
    <label className="flex flex-col gap-0.5 text-[0.6875rem] text-bone-50/55">
      {label}
      <input
        type="date"
        className={inputClass}
        value={periods[which][end]}
        onChange={(e) => setPeriods((p) => ({ ...p, [which]: { ...p[which], [end]: e.target.value } }))}
        aria-invalid={Boolean(fields[`${which}.${end}`])}
      />
      {fields[`${which}.${end}`] ? <span className="text-data-amber">{fields[`${which}.${end}`]}</span> : null}
    </label>
  );

  return (
    <section aria-label="Season comparison" className="flex flex-col gap-2">
      <p className="t-eyebrow text-bone-50/45">Season comparison</p>
      <p className="text-[0.75rem] text-bone-50/55">
        Compare the same season of two years with Sentinel-2 (10 m). ORYN picks the clearest image on one tile in each period and reports regions of at least 2,000 m² where NDVI changed by 0.20 or more. Results are candidate changes to review, not confirmed changes.
      </p>
      {canRun ? (
        <div className="flex flex-col gap-2 rounded-[3px] border border-bone-50/[0.08] p-2">
          <div className="grid grid-cols-2 gap-2">
            {dateInput("Baseline from", "baseline", "from")}
            {dateInput("Baseline to", "baseline", "to")}
            {dateInput("Comparison from", "comparison", "from")}
            {dateInput("Comparison to", "comparison", "to")}
          </div>
          <Button size="sm" variant="primary" onClick={run} disabled={busy}>
            {busy ? "Starting…" : "Compare seasons"}
          </Button>
        </div>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {items && items.length === 0 ? <p className="text-[0.75rem] text-bone-50/50">No comparisons for this area yet.</p> : null}
      <ul className="flex flex-col gap-2">
        {(items ?? []).map((c) => (
          <li key={c.id} className="rounded-[3px] border border-bone-50/[0.08] p-2 text-[0.75rem]">
            <div className="flex items-start justify-between gap-2">
              <span>
                {formatDate(c.baseline.from, "UTC")}–{formatDate(c.baseline.to, "UTC")} vs {formatDate(c.comparison.from, "UTC")}–{formatDate(c.comparison.to, "UTC")}
              </span>
              {c.status === "done" && c.outcome ? (
                <Badge tone={OUTCOME_TONE[c.outcome] ?? "alert"}>{c.outcome === "changes_found" ? `${c.findings} found` : "no result"}</Badge>
              ) : (
                <Badge tone={c.status === "failed" ? "alert" : "info"}>{STEP[c.status]}</Badge>
              )}
            </div>
            {c.status === "done" && c.outcome ? (
              <p className="mt-1 text-bone-50/70">
                <span className="font-medium text-bone-50/85">{OUTCOME_LABEL[c.outcome]}.</span> {c.outcomeDetail}
              </p>
            ) : null}
            {c.status === "failed" ? <p className="mt-1 text-data-amber">{c.error ?? "The comparison failed."}</p> : null}
            {c.status === "done" ? (
              <div className="mt-1.5 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => (open?.id === c.id ? setOpen(null) : void show(c.id))}>{open?.id === c.id ? "Hide details" : "Details"}</Button>
                {canReport ? (
                  report?.comparisonId === c.id ? (
                    <Link className="inline-flex h-7 items-center rounded-[3px] border border-bone-50/20 px-2.5 text-[0.8125rem] hover:border-bone-50/50" href={`/app/${slug}/reports/${report.reportId}`}>
                      Open evidence report
                    </Link>
                  ) : (
                    <Button size="sm" onClick={() => void makeReport(c.id)}>Evidence report (PDF)</Button>
                  )
                ) : null}
              </div>
            ) : null}
            {open?.id === c.id ? (
              <div className="mt-2 flex flex-col gap-1.5">
                {open.images.baseline && open.images.comparison ? (
                  <p className="text-bone-50/55">
                    Images: {open.images.baseline.externalId} ({formatDate(open.images.baseline.acquiredAt, timeZone)}) and {open.images.comparison.externalId} ({formatDate(open.images.comparison.acquiredAt, timeZone)}).
                  </p>
                ) : null}
                {open.items.length ? (
                  <ul className="flex flex-col">
                    {open.items.map((d) => (
                      <li key={d.id}>
                        <button onClick={() => onSelectDetection(d.id)} className="flex w-full items-center justify-between gap-2 border-b border-bone-50/[0.05] py-1 text-left hover:bg-bone-50/[0.03]">
                          <span className="min-w-0 truncate">{d.title}{d.areaM2 ? ` · ${formatArea(d.areaM2)}` : ""}</span>
                          <span className="flex shrink-0 gap-1">
                            <Badge tone={GRADE_TONE[d.evidenceGrade] ?? "muted"}>{d.evidenceGrade}</Badge>
                            <Badge tone={d.verificationStatus === "confirmed" ? "good" : "neutral"}>{d.verificationStatus.replace(/_/g, " ")}</Badge>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
