"use client";

/**
 * Inspector card for a public event (USGS earthquake, NIFC wildfire
 * perimeter): what it is, who reported it, when it was observed versus when
 * ORYN retrieved it, its units and limitations, and what to do next —
 * jump to nearby areas, or record it on one of them as a note.
 *
 * Card fields follow God's Eye View's entity cards (src/layers/perimeters/cards.js,
 * MIT — see THIRD_PARTY_NOTICES.md), reduced to what the feeds actually provide.
 */
import { useMemo, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import { api, ApiError, orgApi } from "@/components/map/api";
import type { AoiFeatureProps, FC } from "@/components/map/types";
import { Badge, Button, Notice } from "@/components/platform/ui";
import { formatDate, relativeTime } from "@/lib/format";
import { bboxOf, formatArea, type Geometry } from "@/lib/geo";
import { PUBLIC_EVENT_LAYERS, type PublicEventFeed, type PublicEventProps } from "@/lib/public-events";

export type SelectedEvent = { props: PublicEventProps; geometry: GeoJSON.Geometry; feed: PublicEventFeed | null };

const EARTH_KM = 6371;
function distanceKm(a: [number, number], b: [number, number]) {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b[1] - a[1]) / 2) ** 2 + Math.cos(r(a[1])) * Math.cos(r(b[1])) * Math.sin(r(b[0] - a[0]) / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
/** Shortest distance from a point to a box (0 inside), km — good enough to rank nearby areas. */
function distanceToBoxKm(p: [number, number], b: [number, number, number, number]) {
  const lon = Math.min(Math.max(p[0], b[0]), b[2]);
  const lat = Math.min(Math.max(p[1], b[1]), b[3]);
  return distanceKm(p, [lon, lat]);
}

/** Approximate gap between two boxes, km (0 when they overlap). */
function boxGapKm(a: [number, number, number, number], b: [number, number, number, number]) {
  const p: [number, number] = [Math.min(Math.max((b[0] + b[2]) / 2, a[0]), a[2]), Math.min(Math.max((b[1] + b[3]) / 2, a[1]), a[3])];
  return distanceToBoxKm(p, b);
}

/** Areas within this distance of an event are listed. */
const NEARBY_KM = { "usgs-earthquakes": 100, "nifc-wildfire-perimeters": 25 } as const;

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  if (v === null || v === undefined || v === "") return null;
  return (
    <div className="flex justify-between gap-3 border-b border-bone-50/[0.05] py-1">
      <dt className="text-bone-50/50">{k}</dt>
      <dd className="text-right text-bone-50/85">{v}</dd>
    </div>
  );
}

export function EventInspector({
  slug,
  timeZone,
  event,
  aois,
  canNote,
  onClose,
  onZoom,
  onSelectAoi,
}: {
  slug: string;
  timeZone: string;
  event: SelectedEvent;
  aois: FC<AoiFeatureProps>;
  canNote: boolean;
  onClose: () => void;
  onZoom: (bbox: [number, number, number, number]) => void;
  onSelectAoi: (id: string) => void;
}) {
  const { props: p, geometry } = event;
  const layer = PUBLIC_EVENT_LAYERS[p.layer];
  const bbox = useMemo(() => bboxOf(geometry as Geometry), [geometry]);
  const [noted, setNoted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nearby = useMemo(() => {
    const centre: [number, number] = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
    return aois.features
      .map((f) => {
        const b = bboxOf(f.geometry as Geometry);
        // From the epicentre for an earthquake; between bounding boxes for a perimeter.
        const d = p.layer === "usgs-earthquakes" ? distanceToBoxKm(centre, b) : boxGapKm(bbox, b);
        const overlaps = p.layer === "nifc-wildfire-perimeters" && b[0] <= bbox[2] && b[2] >= bbox[0] && b[1] <= bbox[3] && b[3] >= bbox[1];
        return { id: f.properties.id, name: f.properties.name, area: f.properties.area_m2, km: overlaps ? 0 : d, overlaps };
      })
      .filter((x) => x.km <= NEARBY_KM[p.layer])
      .sort((a, b) => a.km - b.km)
      .slice(0, 8);
  }, [aois, bbox, p.layer]);

  const noteBody = () => {
    const when = p.observedAt ? `${formatDate(p.observedAt, timeZone)} (${p.observedAt})` : "an unknown time";
    if (p.layer === "usgs-earthquakes") {
      return `Public record (not an ORYN finding): USGS reports ${p.title}, magnitude ${p.magnitude}${p.magnitudeType ? ` ${p.magnitudeType}` : ""}, depth ${p.depthKm ?? "unknown"} km, at ${when}; solution ${p.reviewStatus ?? "status unknown"}. Event ${p.id}.${p.url ? ` Source: ${p.url}` : ""}`;
    }
    return `Public record (not an ORYN finding): NIFC WFIGS lists the ${p.title} fire (${p.id})${p.acres !== null ? `, ${p.acres.toLocaleString("en-US")} acres` : ""}${p.percentContained !== null ? `, ${p.percentContained}% contained` : ""}; perimeter current as of ${when}. Source: ${layer.sourceUrl}`;
  };

  async function record(aoiId: string, name: string) {
    setError(null);
    try {
      await api(`${orgApi(slug)}/notes`, { method: "POST", json: { targetType: "aoi", targetId: aoiId, body: noteBody() } });
      setNoted(name);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not add the note.");
    }
  }

  return (
    <div className="flex flex-col gap-3 p-4 text-[0.8125rem]" aria-label="Public event details">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="t-eyebrow text-bone-50/45">{layer.name} · public record</p>
          <h2 className="mt-1 text-[0.9375rem] font-medium">{p.title}</h2>
        </div>
        <button aria-label="Close" onClick={onClose} className="p-1 text-bone-50/50 hover:text-bone-50"><X className="size-4" /></button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Badge tone="muted">{layer.recordKind === "measurement" ? "Measurement" : "Official report"}</Badge>
        {p.layer === "usgs-earthquakes" && p.reviewStatus ? <Badge tone={p.reviewStatus === "reviewed" ? "good" : "watch"}>{p.reviewStatus === "reviewed" ? "Reviewed by USGS" : "Automatic solution"}</Badge> : null}
        {p.layer === "usgs-earthquakes" && p.tsunamiFlag ? <Badge tone="alert">Tsunami flag</Badge> : null}
        {event.feed && event.feed.state !== "nominal" ? <Badge tone="watch">Feed {event.feed.state}</Badge> : null}
      </div>

      <dl className="text-[0.75rem]">
        {p.layer === "usgs-earthquakes" ? (
          <>
            <Row k="Magnitude" v={`${p.magnitude.toFixed(1)}${p.magnitudeType ? ` (${p.magnitudeType})` : ""}`} />
            <Row k="Depth" v={p.depthKm !== null ? `${p.depthKm.toFixed(1)} km` : "Unknown"} />
            <Row k="Location" v={p.place} />
            <Row k="Origin time" v={p.observedAt ? `${formatDate(p.observedAt, timeZone)} · ${relativeTime(p.observedAt)}` : "Unknown"} />
            <Row k="Solution updated" v={p.updatedAt ? formatDate(p.updatedAt, timeZone) : null} />
            <Row k="Event type" v={p.eventType} />
          </>
        ) : (
          <>
            <Row k="Size" v={p.acres !== null ? `${p.acres.toLocaleString("en-US")} acres (${formatArea(p.acres * 4046.8564)}), as reported` : "Not reported"} />
            <Row k="Containment" v={p.percentContained !== null ? `${p.percentContained}%` : "Not reported"} />
            <Row k="Location" v={[p.county ? `${p.county} County` : null, p.state].filter(Boolean).join(", ") || null} />
            <Row k="Perimeter current as of" v={p.observedAt ? `${formatDate(p.observedAt, timeZone)} · ${relativeTime(p.observedAt)}` : "Unknown"} />
            <Row k="Discovered" v={p.discoveredAt ? formatDate(p.discoveredAt, timeZone) : null} />
            <Row k="Incident type" v={p.incidentType === "WF" ? "Wildfire" : p.incidentType === "RX" ? "Prescribed fire" : p.incidentType} />
            <Row k="Cause" v={p.cause} />
          </>
        )}
        <Row k="Coordinates" v={`${((bbox[1] + bbox[3]) / 2).toFixed(4)}, ${((bbox[0] + bbox[2]) / 2).toFixed(4)}`} />
        <Row k="Source" v={layer.provider} />
        <Row k="Dataset" v={layer.dataset} />
        <Row k="Retrieved by ORYN" v={event.feed?.retrievedAt ? `${formatDate(event.feed.retrievedAt, timeZone)} · ${relativeTime(event.feed.retrievedAt)}` : null} />
        <Row k="Licence" v={layer.license} />
      </dl>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onZoom(bbox)}>Zoom to</Button>
        {p.layer === "usgs-earthquakes" && p.url ? (
          <a className="inline-flex items-center gap-1 text-[0.75rem] text-bone-50/70 underline hover:text-bone-50" href={p.url} target="_blank" rel="noopener noreferrer">
            USGS event page <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        ) : null}
      </div>

      <section aria-label="Nearby areas" className="flex flex-col gap-1">
        <p className="t-eyebrow text-bone-50/45">Your areas within {NEARBY_KM[p.layer]} km</p>
        {nearby.length === 0 ? <p className="text-[0.75rem] text-bone-50/45">None of your areas are this close.</p> : null}
        <ul>
          {nearby.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2 border-b border-bone-50/[0.05] py-1 text-[0.75rem]">
              <button className="min-w-0 truncate text-left hover:underline" onClick={() => onSelectAoi(a.id)}>
                {a.name} <span className="text-bone-50/45">· {a.overlaps ? "inside or touching the perimeter box" : `~${a.km.toFixed(a.km < 10 ? 1 : 0)} km`}</span>
              </button>
              {canNote ? <Button size="sm" variant="ghost" onClick={() => record(a.id, a.name)}>Add note</Button> : null}
            </li>
          ))}
        </ul>
        {nearby.length ? <p className="text-[0.6875rem] text-bone-50/40">Distances are approximate (to each area&apos;s bounding box{p.layer === "nifc-wildfire-perimeters" ? ", and from the perimeter's box" : ""}).</p> : null}
        {noted ? <Notice tone="info">Recorded on “{noted}” as a note, labelled as a public record.</Notice> : null}
        {error ? <p role="alert" className="text-[0.75rem] text-data-amber">{error}</p> : null}
      </section>

      <section aria-label="Limitations" className="text-[0.6875rem] text-bone-50/50">
        <p className="t-eyebrow mb-1 text-bone-50/45">Limitations</p>
        <ul className="list-disc pl-4">
          {layer.limitations.map((l) => <li key={l}>{l}</li>)}
        </ul>
        <p className="mt-1">{layer.attribution}.</p>
      </section>
    </div>
  );
}
