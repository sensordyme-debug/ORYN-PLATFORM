"use client";

/**
 * Detail cards for the intelligence globe: areas (with upcoming imaging
 * overpasses), ORYN findings, and imaging satellites. Public events use the
 * shared EventInspector. Every card states what kind of information it is
 * and links to the workflow where the record is reviewed or acted on.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { api, ApiError, orgApi } from "@/components/map/api";
import { DETECTION_COLORS } from "@/components/map/legend";
import type { AoiFeatureProps, DetectionFeatureProps } from "@/components/map/types";
import { Badge } from "@/components/platform/ui";
import { AOI_KIND_LABEL, type AoiKind } from "@/lib/aoi-config";
import { formatDate, formatDateTime, relativeTime } from "@/lib/format";
import { formatArea } from "@/lib/geo";
import { SATELLITE_SOURCE, type ImagingSatellite, type OverpassResponse, type SatelliteTrack } from "@/lib/intel/satellites";

function Head({ eyebrow, title, onClose }: { eyebrow: string; title: string; onClose: () => void }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="t-eyebrow text-bone-50/45">{eyebrow}</p>
        <h2 className="mt-1 text-[0.9375rem] font-medium">{title}</h2>
      </div>
      <button aria-label="Close" onClick={onClose} className="p-1 text-bone-50/50 hover:text-bone-50"><X className="size-4" /></button>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  if (v === null || v === undefined || v === "") return null;
  return (
    <div className="flex justify-between gap-3 border-b border-bone-50/[0.05] py-1">
      <dt className="text-bone-50/50">{k}</dt>
      <dd className="text-right text-bone-50/85">{v}</dd>
    </div>
  );
}

export function AoiCard({ slug, timeZone, aoi, onClose, onSelectSatellite }: { slug: string; timeZone: string; aoi: AoiFeatureProps; onClose: () => void; onSelectSatellite: (noradId: number) => void }) {
  const [passes, setPasses] = useState<OverpassResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<OverpassResponse>(`${orgApi(slug)}/intel/satellites/passes?aoi=${aoi.id}&days=3`)
      .then((r) => !cancelled && setPasses(r))
      .catch((e: unknown) => !cancelled && setError(e instanceof ApiError ? e.message : "Overpasses are unavailable."));
    return () => {
      cancelled = true;
    };
  }, [slug, aoi.id]);
  return (
    <div className="flex flex-col gap-3 p-4 text-[0.8125rem]" aria-label="Area details">
      <Head eyebrow={`${AOI_KIND_LABEL[aoi.kind as AoiKind] ?? aoi.kind} · your organization`} title={aoi.name} onClose={onClose} />
      <dl className="text-[0.75rem]">
        <Row k="Area" v={formatArea(aoi.area_m2)} />
        <Row k="Open alerts" v={aoi.open_alerts ?? 0} />
        <Row k="Findings to review" v={aoi.unreviewed_detections ?? 0} />
      </dl>
      <div className="flex flex-wrap gap-2 text-[0.75rem]">
        <Link className="rounded-[3px] border border-bone-50/20 px-2 py-1 hover:border-bone-50/50" href={`/app/${slug}/map?aoi=${aoi.id}`}>Open in map workspace</Link>
        <Link className="rounded-[3px] border border-bone-50/20 px-2 py-1 hover:border-bone-50/50" href={`/app/${slug}/areas/${aoi.id}`}>Area settings and history</Link>
      </div>
      <section aria-label="Upcoming imaging overpasses" className="flex flex-col gap-1">
        <p className="t-eyebrow text-bone-50/45">Next imaging opportunities (3 days)</p>
        {error ? <p className="text-[0.75rem] text-data-amber">{error}</p> : null}
        {passes && passes.feed.state === "disabled" ? <p className="text-[0.75rem] text-bone-50/50">{passes.feed.message}</p> : null}
        {passes && passes.feed.state === "unavailable" ? <p className="text-[0.75rem] text-data-amber">{passes.feed.message}</p> : null}
        {!passes && !error ? <p className="text-[0.75rem] text-bone-50/45">Computing…</p> : null}
        {passes && passes.passes.length === 0 && passes.feed.state !== "disabled" && passes.feed.state !== "unavailable" ? (
          <p className="text-[0.75rem] text-bone-50/45">No overpasses within a swath in the next 3 days.</p>
        ) : null}
        <ul className="text-[0.75rem]">
          {passes?.passes.slice(0, 8).map((p) => (
            <li key={`${p.noradId}-${p.time}`} className="flex items-center justify-between gap-2 border-b border-bone-50/[0.05] py-1">
              <button className="text-left hover:underline" onClick={() => onSelectSatellite(p.noradId)}>{p.name}</button>
              <span className="text-right text-bone-50/70">
                {formatDateTime(p.time, timeZone)} <span className="text-bone-50/40">· {Math.round(p.distanceKm)} km off-track</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="text-[0.6875rem] text-bone-50/40">
          Geometric overpasses from orbital elements: the place lies within half the swath. Whether the mission images it depends on its acquisition plan; optical images also need daylight and clear skies.
        </p>
      </section>
    </div>
  );
}

export function DetectionCard({ slug, timeZone, d, onClose }: { slug: string; timeZone: string; d: DetectionFeatureProps; onClose: () => void }) {
  const style = DETECTION_COLORS[d.type] ?? DETECTION_COLORS.other!;
  return (
    <div className="flex flex-col gap-3 p-4 text-[0.8125rem]" aria-label="Finding details">
      <Head eyebrow={`${style.label} · ORYN finding`} title={d.title} onClose={onClose} />
      <div className="flex flex-wrap gap-1.5">
        <Badge tone="muted">Derived analytics</Badge>
        <Badge tone={d.evidence_grade === "strong" ? "good" : d.evidence_grade === "moderate" ? "info" : "watch"}>{d.evidence_grade} evidence</Badge>
        <Badge tone="neutral">{d.verification_status.replace(/_/g, " ")}</Badge>
      </div>
      <dl className="text-[0.75rem]">
        <Row k="Area" v={d.aoi_name} />
        <Row k="Observed" v={d.comparison_observed_at ? formatDate(d.comparison_observed_at, timeZone) : null} />
      </dl>
      <p className="text-[0.75rem] text-bone-50/60">A candidate from satellite analysis, not a confirmed condition. Evidence, imagery, the change map, and review actions are in the map workspace.</p>
      <Link className="self-start rounded-[3px] border border-bone-50/20 px-2 py-1 text-[0.75rem] hover:border-bone-50/50" href={`/app/${slug}/map?detection=${d.id}`}>Review evidence in map workspace</Link>
    </div>
  );
}

export function SatelliteCard({
  timeZone,
  sat,
  track,
  timeMs,
  following,
  onFollow,
  onClose,
}: {
  timeZone: string;
  sat: ImagingSatellite;
  track: SatelliteTrack | null;
  timeMs: number;
  following: boolean;
  onFollow: (on: boolean) => void;
  onClose: () => void;
}) {
  // Nearest computed sample to the shown time (the globe interpolates between samples).
  const sample = track?.samples.reduce((best, s) => (Math.abs(s[0] - timeMs) < Math.abs(best[0] - timeMs) ? s : best), track.samples[0]!);
  const inWindow = sample && Math.abs(sample[0] - timeMs) <= 60_000;
  return (
    <div className="flex flex-col gap-3 p-4 text-[0.8125rem]" aria-label="Satellite details">
      <Head eyebrow={`${sat.mission} · imaging satellite`} title={sat.name} onClose={onClose} />
      <div className="flex flex-wrap gap-1.5">
        <Badge tone="watch">Computed position — not observed</Badge>
        {sat.optical ? <Badge tone="muted">Optical</Badge> : <Badge tone="muted">Radar</Badge>}
      </div>
      <dl className="text-[0.75rem]">
        <Row k="Sensor" v={sat.sensor} />
        <Row k="Swath" v={`${sat.swathKm} km (shaded on the globe)`} />
        <Row k="Feeds ORYN products" v={sat.orynProducts.join(", ")} />
        <Row k="Position at shown time" v={inWindow && sample ? `${sample[2].toFixed(2)}°, ${sample[1].toFixed(2)}° · ${Math.round(sample[3] / 1000)} km up` : "Outside the computed window"} />
        <Row k="Orbital elements epoch" v={track ? `${formatDateTime(track.elementsEpoch, timeZone)} · ${relativeTime(track.elementsEpoch)}` : "No current elements"} />
        <Row k="Source" v={SATELLITE_SOURCE.provider} />
        <Row k="Dataset" v={SATELLITE_SOURCE.dataset} />
      </dl>
      <label className="flex items-center gap-2 text-[0.75rem]">
        <input type="checkbox" checked={following} onChange={(e) => onFollow(e.target.checked)} /> Follow with the camera
      </label>
      <section aria-label="Limitations" className="text-[0.6875rem] text-bone-50/50">
        <p className="t-eyebrow mb-1 text-bone-50/45">Limitations</p>
        <ul className="list-disc pl-4">{SATELLITE_SOURCE.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
        <p className="mt-1">{SATELLITE_SOURCE.attribution}. {SATELLITE_SOURCE.license}</p>
      </section>
    </div>
  );
}
