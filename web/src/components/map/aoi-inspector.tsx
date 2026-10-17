"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { api, ApiError, orgApi } from "@/components/map/api";
import { NotesThread } from "@/components/map/notes";
import { SeriesChart, type PrecipPoint, type SeriesPoint } from "@/components/map/series-chart";
import type { Aoi, AoiAsset, AoiContext, DetectionFeatureProps, FC, Observation } from "@/components/map/types";
import { Badge, Button, KeyValues, Notice, ResultClassBadge } from "@/components/platform/ui";
import { AOI_KIND_LABEL, DATA_SOURCES, type AoiKind } from "@/lib/aoi-config";
import { ageInDays, dataCurrency, formatDate, formatDateTime, formatNumber, formatPercent, relativeTime } from "@/lib/format";
import { formatArea, formatLatLon } from "@/lib/geo";

export type InspectorPerms = { write: boolean; run: boolean; review: boolean; notes: boolean; reports: boolean };

const CURRENCY_TONE = { current: "good", recent: "info", aging: "watch", stale: "alert", none: "muted" } as const;

export function AoiInspector({
  slug,
  aoiId,
  perms,
  timeZone,
  detections,
  activeObservationId,
  onShowObservation,
  onSelectDetection,
  onEditBoundary,
  onChanged,
  onClose,
  onLoaded,
  chartKind: chartKindProp,
  onChartKindChange,
}: {
  slug: string;
  aoiId: string;
  perms: InspectorPerms;
  timeZone: string;
  detections: FC<DetectionFeatureProps> | null;
  activeObservationId: string | null;
  onShowObservation: (o: Observation, all: Observation[]) => void;
  onSelectDetection: (id: string) => void;
  onEditBoundary: (aoi: Aoi) => void;
  onChanged: () => void;
  onClose: () => void;
  onLoaded?: (aoi: Aoi, observations: Observation[]) => void;
  /** Index shown in the trend chart; controlled by the workspace when given (saved scenes restore it). */
  chartKind?: "ndvi" | "ndmi";
  onChartKindChange?: (k: "ndvi" | "ndmi") => void;
}) {
  const [aoi, setAoi] = useState<Aoi | null>(null);
  const [obs, setObs] = useState<Observation[] | null>(null);
  const [assets, setAssets] = useState<AoiAsset[] | null>(null);
  const [context, setContext] = useState<AoiContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const base = `${orgApi(slug)}/aois/${aoiId}`;
    Promise.all([
      api<Aoi>(base),
      api<{ items: Observation[] }>(`${base}/observations`),
      api<{ items: AoiAsset[] }>(`${base}/assets`),
      api<AoiContext>(`${base}/context`).catch(() => null),
    ])
      .then(([a, o, s, c]) => {
        if (cancelled) return;
        setAoi(a);
        setObs(o.items);
        onLoaded?.(a, o.items);
        setAssets(s.items);
        setContext(c);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof ApiError ? e.message : "Could not load this area."));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, aoiId, reload]);

  const ndvi = useMemo(() => (obs ?? []).filter((o) => o.kind === "ndvi"), [obs]);
  const ndmi = useMemo(() => (obs ?? []).filter((o) => o.kind === "ndmi"), [obs]);
  const [chartKindState, setChartKindState] = useState<"ndvi" | "ndmi">("ndvi");
  const chartKind = chartKindProp ?? chartKindState;
  const setChartKind = onChartKindChange ?? setChartKindState;
  const chartObs = chartKind === "ndmi" && ndmi.length ? ndmi : ndvi;
  const latestValid = useMemo(() => (obs ?? []).find((o) => o.status === "valid"), [obs]);
  const latestNdvi = ndvi.find((o) => o.status === "valid");
  const latestAcquired = assets?.[0]?.asset.acquiredAt ?? null;

  const series: SeriesPoint[] = chartObs.map((o) => ({
    id: o.id,
    t: Date.parse(o.observedAt),
    status: o.status,
    mean: (o.metrics.mean as number | undefined) ?? null,
    p10: (o.metrics.p10 as number | undefined) ?? null,
    p90: (o.metrics.p90 as number | undefined) ?? null,
    validFraction: (o.metrics.valid_fraction as number | undefined) ?? (o.quality as { valid_fraction?: number }).valid_fraction ?? null,
    source: o.asset.platform ?? o.asset.collection,
    reason: o.quality.unusable_reason,
  }));

  const precip: PrecipPoint[] = useMemo(() => {
    const byDay = new Map<string, PrecipPoint>();
    const rank = { observation: 3, model_estimate: 2, forecast: 1 } as Record<string, number>;
    for (const w of context?.weather ?? []) {
      if (w.variable !== "precipitation_mm" || w.value === null) continue;
      const day = w.valid_from.slice(0, 10);
      const cur = byDay.get(day);
      if (!cur || (rank[w.record_kind] ?? 0) > (rank[cur.kind] ?? 0)) byDay.set(day, { t: Date.parse(w.valid_from) + 12 * 3600e3, mm: w.value, kind: w.record_kind });
    }
    return [...byDay.values()];
  }, [context]);

  const aoiDetections = (detections?.features ?? []).filter((f) => f.properties.aoi_id === aoiId);

  async function syncNow() {
    setMessage(null);
    try {
      await api(`${orgApi(slug)}/aois/${aoiId}/sync`, { method: "POST", json: {} });
      setMessage("Imagery search and context refresh queued. New observations appear here as processing completes.");
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : "Could not queue the search.");
    }
  }

  async function setArchived(archived: boolean) {
    if (archived && !confirm("Archive this area? Monitoring stops; history is kept.")) return;
    try {
      await api(`${orgApi(slug)}/aois/${aoiId}/archive`, { method: "POST", json: { archived } });
      onChanged();
      setReload((r) => r + 1);
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : "Could not update the area.");
    }
  }

  if (error) return <Notice tone="error" className="m-4">{error}</Notice>;
  if (!aoi) return <p className="p-4 text-[0.8125rem] text-bone-50/50">Loading area…</p>;

  const currency = dataCurrency(latestValid?.observedAt);
  const editable = aoi.geometry.type === "MultiPolygon" && (aoi.geometry.coordinates as unknown[]).length === 1 && aoi.status === "active";

  return (
    <div className="flex flex-col gap-5 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="t-eyebrow text-bone-50/45">{AOI_KIND_LABEL[aoi.kind as AoiKind] ?? aoi.kind}</p>
          <h2 className="mt-1 text-[1.125rem] font-medium leading-tight tracking-[-0.015em]">{aoi.name}</h2>
          <p className="mt-1 text-[0.75rem] text-bone-50/55">{formatArea(aoi.areaM2)} · {formatLatLon(aoi.labelPoint, 4)}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {aoi.status === "archived" ? <Badge tone="muted">Archived</Badge> : aoi.monitoringEnabled ? <Badge tone="good">Monitoring</Badge> : <Badge tone="muted">Monitoring off</Badge>}
            {aoi.isSynthetic ? <Badge tone="watch" title="Development sample boundary">Synthetic boundary</Badge> : null}
          </div>
          <p className="mt-1.5 text-[0.6875rem] text-bone-50/45">
            Boundary: {aoi.boundarySource.method}{aoi.boundarySource.provider ? ` · ${aoi.boundarySource.provider}` : ""}{aoi.boundarySource.external_id ? ` (${aoi.boundarySource.external_id})` : ""}
          </p>
        </div>
        <button onClick={onClose} className="shrink-0 rounded-[3px] px-2 py-1 text-[0.75rem] text-bone-50/50 hover:bg-bone-50/[0.06]" aria-label="Close area details">✕</button>
      </div>

      {message ? <Notice tone="info">{message}</Notice> : null}

      <section aria-label="Data currency" className="rounded-[3px] border border-bone-50/[0.08] p-3">
        <div className="flex items-center justify-between">
          <p className="t-eyebrow text-bone-50/45">Latest usable observation</p>
          <Badge tone={CURRENCY_TONE[currency]}>{currency === "none" ? "None yet" : currency}</Badge>
        </div>
        {latestValid ? (
          <p className="mt-1.5 text-[0.8125rem]">
            Acquired {formatDateTime(latestValid.observedAt, timeZone)} <span className="text-bone-50/50">({relativeTime(latestValid.observedAt)})</span>
          </p>
        ) : (
          <p className="mt-1.5 text-[0.8125rem] text-bone-50/60">
            {obs && obs.length > 0 ? "Imagery was found, but none was usable (cloud or coverage). See the imagery list." : "No imagery has been analyzed for this area yet."}
          </p>
        )}
        {latestAcquired ? <p className="mt-0.5 text-[0.75rem] text-bone-50/50">Newest catalog image: {formatDate(latestAcquired, timeZone)} · last checked {aoi.lastCheckedAt ? relativeTime(aoi.lastCheckedAt) : "never"}</p> : null}
        {latestValid && (ageInDays(latestValid.observedAt) ?? 0) > 10 ? (
          <p className="mt-1.5 text-[0.75rem] text-data-amber">This is not current enough to describe conditions today.</p>
        ) : null}
      </section>

      {latestNdvi ? (
        <section aria-label="Vegetation index" className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <p className="t-eyebrow text-bone-50/45">Vegetation index (NDVI)</p>
            <ResultClassBadge resultClass={latestNdvi.resultClass} />
          </div>
          <p className="text-[0.75rem] text-bone-50/55">Latest usable NDVI: {formatDateTime(latestNdvi.observedAt, timeZone)} · {latestNdvi.asset.platform}</p>
          <div className="grid grid-cols-3 gap-2">
            <Metric label="Mean" value={formatNumber(latestNdvi.metrics.mean as number, 3)} />
            <Metric label="p10 – p90" value={`${formatNumber(latestNdvi.metrics.p10 as number, 2)} – ${formatNumber(latestNdvi.metrics.p90 as number, 2)}`} />
            <Metric label="Cloud-free" value={formatPercent(latestNdvi.metrics.valid_fraction as number)} />
          </div>
        </section>
      ) : null}

      {ndvi.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {ndmi.length > 0 ? (
            <div className="flex overflow-hidden self-start rounded-[3px] border border-bone-50/15 text-[0.6875rem]" role="group" aria-label="Index shown in the chart">
              {(["ndvi", "ndmi"] as const).map((k) => (
                <button key={k} onClick={() => setChartKind(k)} aria-pressed={chartKind === k} className={chartKind === k ? "bg-bone-50 px-2 py-0.5 text-ink-900" : "px-2 py-0.5 text-bone-50/70"}>
                  {k === "ndvi" ? "NDVI (vigour)" : "NDMI (canopy moisture)"}
                </button>
              ))}
            </div>
          ) : null}
          <SeriesChart
            title={
              chartKind === "ndmi" && ndmi.length
                ? "NDMI mean over time (band: p10–p90) · daily precipitation — canopy water content, not soil moisture"
                : "NDVI mean over time (band: p10–p90) · daily precipitation"
            }
            points={series}
            precip={precip}
            yDomain={chartKind === "ndmi" && ndmi.length ? [-0.5, 0.7] : undefined}
            color={chartKind === "ndmi" && ndmi.length ? "#c98500" : undefined}
            activeId={activeObservationId}
            timeZone={timeZone}
            onSelect={(id) => {
              const o = chartObs.find((x) => x.id === id);
              if (o && o.status === "valid") onShowObservation(o, obs ?? []);
            }}
          />
        </div>
      ) : null}

      <section aria-label="Imagery">
        <div className="mb-2 flex items-center justify-between">
          <p className="t-eyebrow text-bone-50/45">Imagery for this area ({assets?.length ?? 0})</p>
          {perms.run && aoi.status === "active" ? (
            <Button size="sm" onClick={syncNow}><RefreshCw className="size-3" aria-hidden="true" /> Check now</Button>
          ) : null}
        </div>
        {assets && assets.length === 0 ? (
          <p className="text-[0.75rem] text-bone-50/50">
            No catalog items yet. {aoi.monitoringEnabled ? "A search was queued when the area was created; results appear once the worker processes it." : "Monitoring is off."}
          </p>
        ) : null}
        <ul className="flex max-h-72 flex-col overflow-y-auto">
          {(assets ?? []).map((a) => {
            const KIND_PREF = ["ndvi", "ndmi", "s1_water", "ndwi", "landcover"];
            const o = (obs ?? [])
              .filter((x) => x.asset.id === a.asset.id && x.hasRaster && x.status === "valid")
              .sort((p, q) => KIND_PREF.indexOf(p.kind) - KIND_PREF.indexOf(q.kind))[0];
            const unusable = (obs ?? []).find((x) => x.asset.id === a.asset.id && x.status === "unusable");
            return (
              <li key={a.asset.id} className="flex items-start justify-between gap-2 border-b border-bone-50/[0.05] py-1.5 text-[0.75rem]">
                <div className="min-w-0">
                  <p className="text-bone-50/85">{formatDate(a.asset.acquiredAt, timeZone)} · {a.asset.platform ?? a.asset.collection}</p>
                  <p className="text-bone-50/45">
                    {a.asset.gsdM ? `${a.asset.gsdM} m` : ""}{a.asset.cloudCover !== null ? ` · scene cloud ${Math.round(a.asset.cloudCover)}%` : ""} · covers {formatPercent(a.coverageFraction)}
                  </p>
                  {a.status === "skipped" || a.status === "unusable" || unusable ? (
                    <p className="text-data-amber/90">{a.statusReason ?? unusable?.quality.unusable_reason ?? "Not usable"}</p>
                  ) : a.status === "queued" || a.status === "discovered" ? (
                    <p className="text-bone-50/45">Queued for analysis</p>
                  ) : a.status === "failed" ? (
                    <p className="text-data-alert">Processing failed — see Processing</p>
                  ) : null}
                </div>
                {o ? (
                  <Button size="sm" variant={o.id === activeObservationId ? "primary" : "secondary"} onClick={() => onShowObservation(o, obs ?? [])}>
                    {o.id === activeObservationId ? "Shown" : "Show"}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      {aoiDetections.length > 0 ? (
        <section aria-label="Candidate changes">
          <p className="t-eyebrow mb-2 text-bone-50/45">Candidate changes ({aoiDetections.length})</p>
          <ul className="flex flex-col">
            {aoiDetections.slice(0, 12).map((d) => (
              <li key={d.properties.id}>
                <button onClick={() => onSelectDetection(d.properties.id)} className="flex w-full items-center justify-between gap-2 border-b border-bone-50/[0.05] py-1.5 text-left text-[0.75rem] hover:bg-bone-50/[0.03]">
                  <span className="min-w-0 truncate">{d.properties.title}</span>
                  <Badge tone={d.properties.verification_status === "confirmed" ? "good" : "neutral"}>{d.properties.verification_status.replace(/_/g, " ")}</Badge>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {context ? <ContextSection context={context} timeZone={timeZone} /> : null}

      <section aria-label="Configuration">
        <p className="t-eyebrow mb-2 text-bone-50/45">Monitoring configuration</p>
        <KeyValues
          items={[
            ["Check interval", `every ${aoi.monitoringIntervalHours} h`],
            ["Next check", aoi.nextCheckAt ? formatDateTime(aoi.nextCheckAt, timeZone) : "—"],
            ["Sources", aoi.dataSources.map((s) => DATA_SOURCES[s as keyof typeof DATA_SOURCES]?.label ?? s).join("; ") || "—"],
            ["Analytics", aoi.enabledAnalytics.join(", ") || "—"],
            ["Cloud limit", `${aoi.maxCloudCover}% scene cloud`],
          ]}
        />
      </section>

      <div className="flex flex-wrap gap-2">
        {perms.write && editable ? <Button size="sm" onClick={() => onEditBoundary(aoi)}>Edit boundary</Button> : null}
        {perms.reports ? <Link className="inline-flex h-7 items-center rounded-[3px] border border-bone-50/20 px-2.5 text-[0.8125rem] hover:border-bone-50/50" href={`/app/${slug}/reports?aoi=${aoi.id}`}>Report</Link> : null}
        <Link className="inline-flex h-7 items-center rounded-[3px] border border-bone-50/20 px-2.5 text-[0.8125rem] hover:border-bone-50/50" href={`/app/${slug}/areas/${aoi.id}`}>Full details</Link>
        {perms.write ? (
          aoi.status === "active" ? <Button size="sm" variant="ghost" onClick={() => setArchived(true)}>Archive</Button> : <Button size="sm" onClick={() => setArchived(false)}>Restore</Button>
        ) : null}
      </div>

      <NotesThread slug={slug} targetType="aoi" targetId={aoi.id} canWrite={perms.notes} timeZone={timeZone} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[3px] border border-bone-50/[0.07] px-2 py-1.5">
      <p className="text-[0.625rem] uppercase tracking-[0.08em] text-bone-50/45">{label}</p>
      <p className="mt-0.5 text-[0.9375rem] tabular-nums">{value}</p>
    </div>
  );
}

function ContextSection({ context, timeZone }: { context: AoiContext; timeZone: string }) {
  const now = Date.parse(context.now);
  const sum = (kind: string, days: number) => {
    const since = now - days * 864e5;
    const rows = context.weather.filter((w) => w.variable === "precipitation_mm" && w.record_kind === kind && Date.parse(w.valid_from) >= since && Date.parse(w.valid_from) <= now && w.value !== null);
    return rows.length ? { mm: rows.reduce((a, w) => a + (w.value ?? 0), 0), n: rows.length, provider: rows[0]!.provider_id } : null;
  };
  const obs7 = sum("observation", 7) ?? sum("model_estimate", 7);
  const forecast = context.weather.filter((w) => w.record_kind === "forecast" && Date.parse(w.valid_from) >= now - 864e5);
  const fmax = forecast.filter((w) => w.variable === "temperature_max_c").slice(0, 3);
  const activeWarnings = context.warnings.filter((w) => w.active);
  return (
    <section aria-label="Weather, warnings, and news" className="flex flex-col gap-3">
      <p className="t-eyebrow text-bone-50/45">Weather & events</p>
      {activeWarnings.length ? (
        <div className="flex flex-col gap-1.5">
          {activeWarnings.map((w) => (
            <Notice key={w.id} tone="warn" title={`Official warning: ${w.title}`}>
              {w.severity ? `${w.severity} · ` : ""}{w.event_start ? `from ${formatDateTime(w.event_start, timeZone)}` : ""}{w.event_end ? ` until ${formatDateTime(w.event_end, timeZone)}` : ""}
              {w.source_url ? <a className="ml-1 underline" href={w.source_url} target="_blank" rel="noreferrer">Source</a> : null}
            </Notice>
          ))}
        </div>
      ) : (
        <p className="text-[0.75rem] text-bone-50/50">No active official weather warnings recorded for this area.</p>
      )}
      <KeyValues
        items={[
          [
            "Rain, last 7 days",
            obs7 ? `${obs7.mm.toFixed(1)} mm (${obs7.n} days, ${obs7.provider === "nws" ? "station observations" : "reanalysis estimate"})` : "No precipitation records",
          ],
          ["Forecast highs", fmax.length ? fmax.map((w) => `${formatDate(w.valid_from, timeZone)} ${Math.round(w.value ?? 0)}°C`).join(" · ") + " (forecast)" : "—"],
        ]}
      />
      {context.news.length ? (
        <div>
          <p className="mb-1 text-[0.75rem] text-bone-50/60">News reports mentioning this area — these are claims by publishers, not verified events.</p>
          <ul className="flex flex-col gap-1">
            {context.news.slice(0, 6).map((n) => (
              <li key={n.article_id} className="text-[0.75rem]">
                <a href={n.url} target="_blank" rel="noreferrer" className="text-bone-50/85 hover:underline">
                  {n.title} <ExternalLink className="inline size-3" aria-hidden="true" />
                </a>
                <span className="block text-bone-50/45">
                  {n.domain} · {n.published_at ? formatDate(n.published_at, timeZone) : "date unknown"} · {n.category} · {n.independent_sources} independent source{n.independent_sources === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
