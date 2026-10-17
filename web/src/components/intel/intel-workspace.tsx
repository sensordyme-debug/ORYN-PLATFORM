"use client";

/**
 * The 3D intelligence globe (CesiumJS) inside the authenticated ORYN
 * platform. It shares the 2D map workspace's data model and APIs: every
 * record comes from a permission-checked /api/v1/orgs/[org] endpoint, and
 * review, notes, and reports stay in the existing workflows it links to.
 */
import "@cesium/engine/Source/Widget/CesiumWidget.css";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Layers, Map as MapIcon, Search, X } from "lucide-react";
import { CameraCard } from "@/components/intel/camera-card";
import { GlobeScene, loadCesium, type Picked } from "@/components/intel/globe-scene";
import { AoiCard, DetectionCard, SatelliteCard } from "@/components/intel/intel-cards";
import { TimeBar } from "@/components/intel/time-bar";
import { api, ApiError, orgApi } from "@/components/map/api";
import { EventInspector } from "@/components/map/event-inspector";
import type { AoiFeatureProps, DetectionFeatureProps, FC } from "@/components/map/types";
import { Badge, Button, inputClass, Notice } from "@/components/platform/ui";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/format";
import { bboxOf, parseCoordinates, type Geometry } from "@/lib/geo";
import type { CameraRecord, CamerasResponse } from "@/lib/intel/cameras";
import { INTEL_LAYER_IDS, INTEL_LAYERS, INTEL_MODES, type IntelLayerId, type IntelMode, type IntelModeId } from "@/lib/intel/layers";
import { IMAGING_SATELLITES, type SatelliteTracksResponse } from "@/lib/intel/satellites";
import { FEED_STATE_LABEL, type FeedState, type PublicEventProps, type PublicEventsResponse } from "@/lib/public-events";

export type LayerAvailability = Record<IntelLayerId, { enabled: true } | { enabled: false; reason: string }>;

export type IntelWorkspaceProps = {
  slug: string;
  timeZone: string;
  canNote: boolean;
  initialAois: FC<AoiFeatureProps>;
  initialBounds: [number, number, number, number] | null;
  availability: LayerAvailability;
  usgsAerialTemplate: string;
  focus: { at?: { lon: number; lat: number; heightM: number } };
};

type EventLayerId = "usgs-earthquakes" | "nifc-wildfire-perimeters";
type Loaded<T> = { res: T | null; error: string | null; key: string };
const WORLD = "-180,-90,180,90";
const CALIFORNIA: [number, number, number, number] = [-124.5, 32.4, -114.1, 42.05];
const FEED_TONE: Record<FeedState, "good" | "info" | "watch" | "alert" | "muted"> = { nominal: "good", loading: "muted", partial: "info", stale: "watch", unavailable: "alert", disabled: "muted" };
const yesterdayUtc = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

function errText(e: unknown, fallback: string) {
  return e instanceof ApiError ? e.message : fallback;
}

export function IntelWorkspace(props: IntelWorkspaceProps) {
  const { slug, timeZone, availability } = props;
  const container = useRef<HTMLDivElement>(null);
  const credits = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState<GlobeScene | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [layers, setLayers] = useState<Record<IntelLayerId, boolean>>(() => {
    const on = new Set<IntelLayerId>(["aois", "detections", "satellites"]);
    return Object.fromEntries(INTEL_LAYER_IDS.map((id) => [id, on.has(id) && availability[id].enabled])) as Record<IntelLayerId, boolean>;
  });
  const [mode, setMode] = useState<IntelModeId | null>(null);
  const [eventDays, setEventDays] = useState<1 | 7 | 30>(7);
  const [viirsDate, setViirsDate] = useState(yesterdayUtc);
  /** Shown time, coarse (updates every 30 s of clock time or on scrub). */
  const [timeMs, setTimeMs] = useState(() => Date.now());
  /** Wall-clock now, refreshed every 30 s (render code must not read the clock directly). */
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [sel, setSel] = useState<Picked | null>(null);
  const [follow, setFollow] = useState(false);
  const [detections, setDetections] = useState<Loaded<FC<DetectionFeatureProps>> | null>(null);
  const [events, setEvents] = useState<Partial<Record<EventLayerId, Loaded<PublicEventsResponse>>>>({});
  const [sats, setSats] = useState<(Loaded<SatelliteTracksResponse> & { center: number }) | null>(null);
  const [cams, setCams] = useState<Loaded<CamerasResponse> | null>(null);
  /** Cameras matching the search box anywhere in the registry (not only the loaded view). */
  const [camHits, setCamHits] = useState<CameraRecord[]>([]);
  const [viewBox, setViewBox] = useState(WORLD);
  const [view2d, setView2d] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [leftOpen, setLeftOpen] = useState(true);
  const [eventsVersion, setEventsVersion] = useState(0);

  // ── Create the globe once ──────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let created: GlobeScene | null = null;
    const cleanups: (() => void)[] = [];
    loadCesium()
      .then((C) => {
        if (cancelled || !container.current || !credits.current) return;
        try {
          created = new GlobeScene(C, container.current, credits.current, props.usgsAerialTemplate);
        } catch (e) {
          setFatal(e instanceof Error && /webgl/i.test(e.message) ? "This browser or device does not provide WebGL, which the 3D globe needs." : "The 3D globe could not start in this browser.");
          return;
        }
        const s = created;
        const at = props.focus.at;
        if (at) s.flyTo(at.lon, at.lat, at.heightM, 0);
        else if (props.initialBounds) {
          const b = props.initialBounds;
          s.flyTo((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, 2_500_000, 0);
        } else s.flyTo(-95, 32, 20_000_000, 0);
        let last = 0;
        cleanups.push(
          s.onTick((ms) => {
            if (Math.abs(ms - last) >= 30_000) {
              last = ms;
              setTimeMs(ms);
            }
          }),
        );
        const onMove = () => {
          const b = s.viewBbox();
          const pad = (v: number) => Math.round(v * 10) / 10;
          setViewBox(b ? [Math.max(-180, b[0] - 0.5), Math.max(-90, b[1] - 0.5), Math.min(180, b[2] + 0.5), Math.min(90, b[3] + 0.5)].map(pad).join(",") : WORLD);
          const v = s.view();
          const zoom = Math.max(1, Math.min(18, Math.log2(35_000_000 / Math.max(v.heightM, 50))));
          setView2d(`${v.lon.toFixed(4)},${v.lat.toFixed(4)},${zoom.toFixed(1)}`);
        };
        cleanups.push(s.onMoveEnd(onMove));
        cleanups.push(
          s.onPick((p) => {
            setFollow(false);
            setSel(p);
          }),
        );
        setScene(s);
      })
      .catch(() => !cancelled && setFatal("The 3D engine could not be loaded."));
    return () => {
      cancelled = true;
      for (const c of cleanups) c();
      created?.destroy();
    };
    // Created once; later prop changes are pushed through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Data (all through ORYN's permission-checked APIs) ───────────
  useEffect(() => {
    if (!layers.detections || detections) return;
    let cancelled = false;
    api<FC<DetectionFeatureProps>>(`${orgApi(slug)}/detections?verification=unverified,needs_field_check,confirmed&minGrade=moderate&withinDays=365`)
      .then((res) => !cancelled && setDetections({ res, error: null, key: "" }))
      .catch((e: unknown) => !cancelled && setDetections({ res: null, error: errText(e, "Could not load findings."), key: "" }));
    return () => {
      cancelled = true;
    };
  }, [slug, layers.detections, detections]);

  useEffect(() => {
    let cancelled = false;
    for (const id of ["usgs-earthquakes", "nifc-wildfire-perimeters"] as const) {
      if (!layers[id]) continue;
      api<PublicEventsResponse>(`${orgApi(slug)}/public-events/${id}?bbox=${WORLD}&days=30`)
        .then((res) => !cancelled && setEvents((d) => ({ ...d, [id]: { res, error: null, key: String(eventsVersion) } })))
        .catch((e: unknown) => !cancelled && setEvents((d) => ({ ...d, [id]: { res: d[id]?.res ?? null, error: errText(e, "Could not load this layer."), key: String(eventsVersion) } })));
    }
    return () => {
      cancelled = true;
    };
  }, [slug, layers, eventsVersion]);

  // Public feeds refresh every 5 minutes while shown (the server caches; this only picks up its newer snapshot).
  useEffect(() => {
    const t = setInterval(() => setEventsVersion((v) => v + 1), 5 * 60_000);
    const n = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => {
      clearInterval(t);
      clearInterval(n);
    };
  }, []);

  const satCenter = sats?.center ?? null;
  const satInRange = Math.abs(timeMs - nowMs) <= 7 * 86_400_000;
  useEffect(() => {
    if (!layers.satellites || !satInRange) return;
    if (satCenter !== null && Math.abs(timeMs - satCenter) < 35 * 60_000) return;
    let cancelled = false;
    const center = Math.round(timeMs / 60_000) * 60_000;
    api<SatelliteTracksResponse>(`${orgApi(slug)}/intel/satellites?at=${new Date(center).toISOString()}`)
      .then((res) => !cancelled && setSats({ res, error: null, key: "", center }))
      .catch((e: unknown) => !cancelled && setSats((s) => ({ res: s?.res ?? null, error: errText(e, "Could not load satellite tracks."), key: "", center })));
    return () => {
      cancelled = true;
    };
  }, [slug, layers.satellites, timeMs, satCenter, satInRange]);

  useEffect(() => {
    if (!layers.cameras) return;
    let cancelled = false;
    api<CamerasResponse>(`${orgApi(slug)}/intel/cameras?bbox=${viewBox}`)
      .then((res) => !cancelled && setCams({ res, error: null, key: viewBox }))
      .catch((e: unknown) => !cancelled && setCams((c) => ({ res: c?.res ?? null, error: errText(e, "Could not load cameras."), key: viewBox })));
    return () => {
      cancelled = true;
    };
  }, [slug, layers.cameras, viewBox]);

  useEffect(() => {
    const q = query.trim();
    if (!layers.cameras || q.length < 3) return;
    let cancelled = false;
    const t = setTimeout(() => {
      api<CamerasResponse>(`${orgApi(slug)}/intel/cameras?q=${encodeURIComponent(q)}`)
        .then((r) => !cancelled && setCamHits(r.cameras))
        .catch(() => !cancelled && setCamHits([]));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [slug, layers.cameras, query]);

  /** A camera from the loaded view or from a registry search. */
  const findCamera = (id: string) => cams?.res?.cameras.find((x) => x.id === id) ?? camHits.find((x) => x.id === id) ?? null;

  // ── Push state into the scene ───────────────────────────────────
  const selKey = (k: Picked["kind"]) => (sel?.kind === k ? sel.id : null);
  const selAoi = selKey("aoi");
  const selDet = selKey("detection");
  const selEv = selKey("event");
  const selSat = selKey("satellite");
  const selCam = selKey("camera");
  const quakeFeatures = events["usgs-earthquakes"]?.res?.features.features;
  const fireFeatures = events["nifc-wildfire-perimeters"]?.res?.features.features;

  useEffect(() => scene?.setSelected(sel), [scene, sel]);
  useEffect(() => scene?.setAois(props.initialAois, layers.aois), [scene, props.initialAois, layers.aois, selAoi]);
  useEffect(() => scene?.setDetections(detections?.res ?? null, layers.detections), [scene, detections, layers.detections, selDet]);
  useEffect(() => scene?.setQuakes(quakeFeatures ?? [], layers["usgs-earthquakes"]), [scene, quakeFeatures, layers, selEv]);
  useEffect(() => scene?.setQuakeWindow(timeMs - eventDays * 86_400_000, timeMs), [scene, quakeFeatures, timeMs, eventDays, selEv]);
  useEffect(() => scene?.setFires(fireFeatures ?? [], layers["nifc-wildfire-perimeters"]), [scene, fireFeatures, layers, selEv]);
  // Perimeters are a present-day snapshot: never shown for times more than a day away.
  const firesNow = Math.abs(timeMs - nowMs) < 86_400_000;
  useEffect(() => scene?.setFiresVisible(layers["nifc-wildfire-perimeters"] && firesNow), [scene, layers, firesNow, fireFeatures, selEv]);
  useEffect(() => scene?.setSatellites(sats?.res ?? null, layers.satellites), [scene, sats?.res, layers.satellites, selSat]);
  useEffect(() => scene?.setCameras(cams?.res?.cameras ?? [], layers.cameras), [scene, cams?.res, layers.cameras, selCam]);
  useEffect(() => scene?.setViirs(layers["viirs-daily"] ? viirsDate : null), [scene, layers, viirsDate]);
  useEffect(() => scene?.setAerial(layers["usgs-aerial"]), [scene, layers]);
  useEffect(() => scene?.follow(follow && selSat ? `sat:${selSat}` : null), [scene, follow, selSat, sats?.res]);

  const selEvent = (() => {
    if (sel?.kind !== "event") return null;
    for (const id of ["usgs-earthquakes", "nifc-wildfire-perimeters"] as const) {
      const r = events[id]?.res;
      const f = r?.features.features.find((x) => x.properties.id === sel.id);
      if (f && r) return { props: f.properties as PublicEventProps, geometry: f.geometry, feed: r.feed };
    }
    return null;
  })();
  const selCamera: CameraRecord | null = sel?.kind === "camera" ? findCamera(sel.id) : null;

  // ── Actions ─────────────────────────────────────────────────────
  function flyToPicked(p: Picked) {
    if (!scene) return;
    if (p.kind === "aoi") {
      const f = props.initialAois.features.find((x) => x.properties.id === p.id);
      if (f) scene.flyToBbox(bboxOf(f.geometry as Geometry));
    } else if (p.kind === "detection") {
      const f = detections?.res?.features.find((x) => x.properties.id === p.id);
      if (f) scene.flyToBbox(bboxOf(f.geometry as Geometry));
    } else if (p.kind === "event") {
      const f = [...(quakeFeatures ?? []), ...(fireFeatures ?? [])].find((x) => x.properties.id === p.id);
      if (f?.geometry.type === "Point") scene.flyTo(f.geometry.coordinates[0]!, f.geometry.coordinates[1]!, 600_000);
      else if (f) scene.flyToBbox(bboxOf(f.geometry as Geometry));
    } else if (p.kind === "satellite") {
      const t = sats?.res?.satellites.find((s) => String(s.noradId) === p.id)?.track;
      const s = t?.samples.reduce((best, x) => (Math.abs(x[0] - timeMs) < Math.abs(best[0] - timeMs) ? x : best), t.samples[0]!);
      if (s) scene.flyTo(s[1], s[2], s[3] + 4_000_000);
    } else if (p.kind === "camera") {
      const c = findCamera(p.id);
      if (c) scene.flyTo(c.lon, c.lat, 4_000);
    }
  }

  function select(p: Picked) {
    setFollow(false);
    setSel(p);
    flyToPicked(p);
  }

  function applyMode(m: IntelMode) {
    const next = Object.fromEntries(INTEL_LAYER_IDS.map((id) => [id, false])) as Record<IntelLayerId, boolean>;
    const skipped: string[] = [];
    for (const id of m.layers) {
      if (availability[id].enabled) next[id] = true;
      else skipped.push(INTEL_LAYERS[id].name);
    }
    setLayers(next);
    setMode(m.id);
    if (m.eventDays) setEventDays(m.eventDays);
    if (m.camera === "globe") scene?.flyTo(-40, 25, 22_000_000);
    else if (m.camera === "california") scene?.flyToBbox(CALIFORNIA);
    else if (props.initialBounds) scene?.flyToBbox(props.initialBounds);
    setNotice(
      [
        skipped.length ? `${m.label}: ${skipped.join(", ")} ${skipped.length > 1 ? "are" : "is"} not available in this deployment, so ${skipped.length > 1 ? "they stay" : "it stays"} off.` : null,
        m.camera === "areas" && !props.initialAois.features.length ? "Your organization has no areas yet; draw one in the map workspace." : null,
      ]
        .filter(Boolean)
        .join(" ") || null,
    );
  }

  // ── Search across loaded entities ───────────────────────────────
  type Hit = { label: string; sub: string; pick?: Picked; coords?: [number, number] };
  const hits = useMemo<Hit[]>(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const coords = parseCoordinates(query);
    const out: Hit[] = coords ? [{ label: `${coords[1].toFixed(4)}, ${coords[0].toFixed(4)}`, sub: "Coordinates", coords }] : [];
    const has = (s: string | null | undefined) => Boolean(s && s.toLowerCase().includes(q));
    for (const f of props.initialAois.features) if (has(f.properties.name)) out.push({ label: f.properties.name, sub: "Area", pick: { kind: "aoi", id: f.properties.id } });
    for (const f of detections?.res?.features ?? []) if (has(f.properties.title) || has(f.properties.aoi_name)) out.push({ label: f.properties.title, sub: `Finding · ${f.properties.aoi_name}`, pick: { kind: "detection", id: f.properties.id } });
    for (const s of IMAGING_SATELLITES) if (has(s.name) || has(s.mission)) out.push({ label: s.name, sub: "Imaging satellite (computed position)", pick: { kind: "satellite", id: String(s.noradId) } });
    for (const f of quakeFeatures ?? []) if (f.properties.layer === "usgs-earthquakes" && (has(f.properties.title) || has(f.properties.place))) out.push({ label: f.properties.title, sub: "Earthquake · USGS", pick: { kind: "event", id: f.properties.id, layer: "usgs-earthquakes" } });
    for (const f of fireFeatures ?? []) if (f.properties.layer === "nifc-wildfire-perimeters" && (has(f.properties.title) || has(f.properties.county))) out.push({ label: f.properties.title, sub: "Wildfire perimeter · NIFC", pick: { kind: "event", id: f.properties.id, layer: "nifc-wildfire-perimeters" } });
    const seen = new Set<string>();
    for (const c of [...(cams?.res?.cameras ?? []), ...(layers.cameras && query.trim().length >= 3 ? camHits : [])]) {
      if (seen.has(c.id) || !(has(c.name) || has(c.route) || has(c.nearby))) continue;
      seen.add(c.id);
      out.push({ label: c.name, sub: `Camera · ${c.video ? "live video" : "stills"}`, pick: { kind: "camera", id: c.id } });
    }
    return out.slice(0, 12);
  }, [query, props.initialAois, detections, quakeFeatures, fireFeatures, cams, camHits, layers.cameras]);

  // ── Layer status ────────────────────────────────────────────────
  function layerStatus(id: IntelLayerId): { state: FeedState | null; count: number | null; retrievedAt: string | null; message: string | null } {
    const off = availability[id];
    if (!off.enabled) return { state: "disabled", count: null, retrievedAt: null, message: off.reason };
    if (!layers[id]) return { state: null, count: null, retrievedAt: null, message: null };
    switch (id) {
      case "aois":
        return { state: "nominal", count: props.initialAois.features.length, retrievedAt: null, message: null };
      case "detections":
        return detections ? { state: detections.error ? "unavailable" : "nominal", count: detections.res?.features.length ?? null, retrievedAt: null, message: detections.error } : { state: "loading", count: null, retrievedAt: null, message: null };
      case "usgs-earthquakes":
      case "nifc-wildfire-perimeters": {
        const d = events[id];
        if (!d) return { state: "loading", count: null, retrievedAt: null, message: null };
        const shown = id === "usgs-earthquakes" ? (d.res?.features.features ?? []).filter((f) => f.properties.observedAt && Date.parse(f.properties.observedAt) <= timeMs && Date.parse(f.properties.observedAt) >= timeMs - eventDays * 86_400_000).length : (d.res?.total ?? null);
        const hidden = id === "nifc-wildfire-perimeters" && !firesNow ? "Hidden at this time: perimeters are a current snapshot, not a history." : null;
        return { state: d.error ? (d.res ? "stale" : "unavailable") : (d.res?.feed.state ?? "loading"), count: shown, retrievedAt: d.res?.feed.retrievedAt ?? null, message: [d.error ?? d.res?.feed.message, hidden].filter(Boolean).join(" ") || null };
      }
      case "satellites": {
        if (!satInRange) return { state: "unavailable", count: null, retrievedAt: null, message: "Satellite positions are computed only within 7 days of now." };
        if (!sats) return { state: "loading", count: null, retrievedAt: null, message: null };
        return { state: sats.error ? (sats.res ? "stale" : "unavailable") : (sats.res?.feed.state ?? "loading"), count: sats.res?.satellites.filter((s) => s.track).length ?? null, retrievedAt: sats.res?.feed.retrievedAt ?? null, message: sats.error ?? sats.res?.feed.message ?? null };
      }
      case "cameras": {
        if (!cams) return { state: "loading", count: null, retrievedAt: null, message: null };
        return { state: cams.error ? (cams.res ? "stale" : "unavailable") : (cams.res?.feed.state ?? "loading"), count: cams.res?.total ?? null, retrievedAt: cams.res?.feed.retrievedAt ?? null, message: cams.error ?? cams.res?.feed.message ?? null };
      }
      default:
        return { state: null, count: null, retrievedAt: null, message: null };
    }
  }

  const groups = ["ORYN data", "Public events", "Orbits", "Cameras", "Imagery"] as const;
  const satMeta = selSat ? IMAGING_SATELLITES.find((s) => String(s.noradId) === selSat) : undefined;
  const selDetection = selDet ? detections?.res?.features.find((f) => f.properties.id === selDet)?.properties : undefined;
  const selArea = selAoi ? props.initialAois.features.find((f) => f.properties.id === selAoi)?.properties : undefined;

  return (
    <div className="relative flex h-full min-h-0">
      {/* Left panel: search, modes, layers */}
      <aside className={cn("absolute inset-y-0 left-0 z-20 flex w-[310px] max-w-[85vw] flex-col border-r border-bone-50/[0.08] bg-ink-950/95 backdrop-blur transition-transform lg:static lg:translate-x-0", leftOpen ? "translate-x-0" : "-translate-x-full lg:hidden")}>
        <div className="flex items-center gap-2 border-b border-bone-50/[0.08] p-3" role="search">
          <Search className="size-4 shrink-0 text-bone-50/45" aria-hidden="true" />
          <input aria-label="Search areas, findings, satellites, events, cameras, or coordinates" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the globe or enter lat, lon" className="min-w-0 flex-1 bg-transparent text-[0.8125rem] placeholder:text-bone-50/30 focus:outline-none" />
          {query ? <button aria-label="Clear search" onClick={() => setQuery("")}><X className="size-3.5 text-bone-50/50" /></button> : null}
        </div>
        {hits.length ? (
          <ul className="border-b border-bone-50/[0.08] p-2" aria-label="Search results">
            {hits.map((h, i) => (
              <li key={i}>
                <button
                  className="block w-full rounded-[2px] px-2 py-1.5 text-left text-[0.75rem] hover:bg-bone-50/[0.05]"
                  onClick={() => {
                    if (h.pick) select(h.pick);
                    else if (h.coords) scene?.flyTo(h.coords[0], h.coords[1], 20_000);
                    setQuery("");
                  }}
                >
                  <span className="block text-bone-50/85">{h.label}</span>
                  <span className="text-bone-50/40">{h.sub}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto p-3 text-[0.8125rem]">
          <section aria-label="Modes" className="mb-4">
            <p className="t-eyebrow mb-2 text-bone-50/45">Modes</p>
            <div className="flex flex-col gap-1">
              {INTEL_MODES.map((m) => (
                <button key={m.id} onClick={() => applyMode(m)} aria-pressed={mode === m.id} className={cn("rounded-[3px] border px-2 py-1.5 text-left", mode === m.id ? "border-signal/60 bg-signal/[0.06]" : "border-bone-50/10 hover:border-bone-50/30")}>
                  <span className="block text-[0.8125rem]">{m.label}</span>
                  <span className="block text-[0.6875rem] text-bone-50/45">{m.description}</span>
                </button>
              ))}
            </div>
          </section>
          {groups.map((g) => (
            <fieldset key={g} className="mb-4 min-w-0">
              <legend className="t-eyebrow mb-2 text-bone-50/45">{g}</legend>
              {INTEL_LAYER_IDS.filter((id) => INTEL_LAYERS[id].group === g).map((id) => {
                const l = INTEL_LAYERS[id];
                const st = layerStatus(id);
                const enabled = availability[id].enabled;
                return (
                  <div key={id} className="py-1">
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        disabled={!enabled}
                        checked={layers[id]}
                        onChange={(e) => {
                          setMode(null);
                          setLayers((s) => ({ ...s, [id]: e.target.checked }));
                        }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span>{l.name}</span>
                          {st.state ? <Badge tone={FEED_TONE[st.state]}>{st.state === "disabled" ? "Off" : FEED_STATE_LABEL[st.state]}</Badge> : null}
                        </span>
                        <span className="block text-[0.6875rem] text-bone-50/45">{l.kind} · {l.description}</span>
                        {st.count !== null ? (
                          <span className="block text-[0.6875rem] text-bone-50/55">
                            {st.count} {id === "usgs-earthquakes" ? `in the ${eventDays === 1 ? "24 hours" : `${eventDays} days`} before the shown time` : "shown"}
                            {st.retrievedAt ? ` · retrieved ${relativeTime(st.retrievedAt)}` : ""}
                          </span>
                        ) : null}
                        {st.message ? <span className="block text-[0.6875rem] text-data-amber">{st.message}</span> : null}
                        {l.attribution && layers[id] ? <span className="block text-[0.6875rem] text-bone-50/35">{l.attribution}</span> : null}
                      </span>
                    </label>
                    {id === "usgs-earthquakes" && layers[id] ? (
                      <label className="ml-6 mt-1 flex items-center gap-2 text-[0.75rem] text-bone-50/60">
                        Window
                        <select className={cn(inputClass, "w-auto py-0.5 text-[0.75rem]")} value={eventDays} onChange={(e) => setEventDays(Number(e.target.value) as 1 | 7 | 30)}>
                          <option value={1}>24 hours</option><option value={7}>7 days</option><option value={30}>30 days</option>
                        </select>
                      </label>
                    ) : null}
                    {id === "viirs-daily" && layers[id] ? (
                      <label className="ml-6 mt-1 flex items-center gap-2 text-[0.75rem] text-bone-50/60">
                        UTC day
                        <input type="date" className={cn(inputClass, "w-auto py-0.5 text-[0.75rem]")} value={viirsDate} max={new Date().toISOString().slice(0, 10)} min={new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10)} onChange={(e) => e.target.value && setViirsDate(e.target.value)} />
                      </label>
                    ) : null}
                    {id === "satellites" && layers[id] && sats?.res ? (
                      <ul className="ml-6 mt-1" aria-label="Imaging satellites">
                        {sats.res.satellites.map((s) => (
                          <li key={s.noradId}>
                            <button disabled={!s.track} onClick={() => select({ kind: "satellite", id: String(s.noradId) })} className={cn("block w-full truncate rounded-[2px] px-1 py-0.5 text-left text-[0.75rem] hover:bg-bone-50/[0.05] disabled:opacity-40", selSat === String(s.noradId) ? "text-signal" : "text-bone-50/75")}>
                              {s.name} <span className="text-bone-50/40">· {s.mission}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                );
              })}
            </fieldset>
          ))}
          <p className="text-[0.6875rem] text-bone-50/40">Base globe: NASA Blue Marble (GIBS). Lighting follows the shown time. No paid map services are used.</p>
        </div>
      </aside>

      {/* Globe */}
      <div className="relative min-w-0 flex-1 bg-ink-950">
        <div ref={container} className="absolute inset-0" role="application" aria-label="3D intelligence globe" />
        {fatal ? (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <div className="max-w-sm rounded-[4px] border border-bone-50/[0.1] bg-ink-950/95 p-5 text-center text-[0.8125rem]">
              <p className="font-medium">3D view unavailable</p>
              <p className="mt-1 text-bone-50/60">{fatal}</p>
              <Link className="mt-3 inline-block underline" href={`/app/${slug}/map`}>Open the 2D map workspace</Link>
            </div>
          </div>
        ) : !scene ? (
          <p className="absolute left-1/2 top-1/2 -translate-x-1/2 text-[0.8125rem] text-bone-50/55" role="status">Loading the 3D globe…</p>
        ) : null}
        <div className="absolute left-3 top-3 z-10 flex flex-wrap gap-2">
          <Button size="sm" className="bg-ink-950/90 lg:hidden" onClick={() => setLeftOpen((o) => !o)} aria-expanded={leftOpen}>
            <Layers className="size-3.5" aria-hidden="true" /> Panel
          </Button>
          <Link href={`/app/${slug}/map${view2d ? `?at=${view2d}` : ""}`} className="inline-flex items-center gap-1.5 rounded-[3px] border border-bone-50/20 bg-ink-950/90 px-2.5 py-1 text-[0.75rem] hover:border-bone-50/50">
            <MapIcon className="size-3.5" aria-hidden="true" /> 2D map workspace
          </Link>
        </div>
        {notice ? (
          <div className="absolute left-1/2 top-3 z-20 w-[min(560px,90%)] -translate-x-1/2">
            <Notice tone="info" className="bg-ink-950/95">
              <span className="flex items-start justify-between gap-3">{notice}<button aria-label="Dismiss" onClick={() => setNotice(null)}><X className="size-3.5" /></button></span>
            </Notice>
          </div>
        ) : null}
        {scene ? (
          <div className="absolute inset-x-3 bottom-8 z-10 rounded-[4px] border border-bone-50/[0.1] bg-ink-950/92 px-3 py-2 backdrop-blur lg:right-auto lg:max-w-[min(820px,calc(100%-420px))]">
            <TimeBar scene={scene} timeZone={timeZone} />
          </div>
        ) : null}
        {/* Cesium renders its credits here; on-screen credits stay visible, the rest are behind "Data attribution". The
            Cesium ion logo is hidden because ORYN does not use Cesium ion; the engine is credited as CesiumJS instead. */}
        <div className="absolute bottom-1 right-2 z-10 flex max-w-[55%] flex-wrap items-center justify-end gap-x-2 text-right text-[0.625rem] leading-tight text-bone-50/60">
          <div
            ref={credits}
            aria-label="Globe data credits"
            className="[&_.cesium-credit-logoContainer]:!hidden [&_.cesium-widget-credits]:!static [&_.cesium-widget-credits]:!inline [&_.cesium-credit-wrapper]:after:content-['·'] [&_.cesium-credit-wrapper]:after:px-1 [&_a]:cursor-pointer [&_a]:underline"
          />
          <span>3D engine: CesiumJS</span>
        </div>

        {/* Right inspector */}
        {sel ? (
          <aside className="absolute inset-y-0 right-0 z-20 w-[380px] max-w-full overflow-y-auto border-l border-bone-50/[0.08] bg-ink-950/96 backdrop-blur" aria-label="Details">
            {sel.kind === "aoi" && selArea ? (
              <AoiCard slug={slug} timeZone={timeZone} aoi={selArea} onClose={() => setSel(null)} onSelectSatellite={(n) => select({ kind: "satellite", id: String(n) })} />
            ) : sel.kind === "detection" && selDetection ? (
              <DetectionCard slug={slug} timeZone={timeZone} d={selDetection} onClose={() => setSel(null)} />
            ) : sel.kind === "event" && selEvent ? (
              <EventInspector
                key={selEvent.props.id}
                slug={slug}
                timeZone={timeZone}
                event={selEvent}
                aois={props.initialAois}
                canNote={props.canNote}
                onClose={() => setSel(null)}
                onZoom={(b) => scene?.flyToBbox(b)}
                onSelectAoi={(id) => select({ kind: "aoi", id })}
              />
            ) : sel.kind === "satellite" && satMeta ? (
              <SatelliteCard
                timeZone={timeZone}
                sat={satMeta}
                track={sats?.res?.satellites.find((s) => s.noradId === satMeta.noradId)?.track ?? null}
                timeMs={scene?.timeMs() ?? timeMs}
                following={follow}
                onFollow={setFollow}
                onClose={() => setSel(null)}
              />
            ) : sel.kind === "camera" && selCamera ? (
              <CameraCard key={selCamera.id} slug={slug} cam={selCamera} timeZone={timeZone} onClose={() => setSel(null)} />
            ) : (
              <p className="p-4 text-[0.75rem] text-bone-50/50">This item is no longer in the loaded data. <button className="underline" onClick={() => setSel(null)}>Close</button></p>
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
