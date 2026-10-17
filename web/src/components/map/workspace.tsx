"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Map as MlMap } from "maplibre-gl";
import { Circle, Globe2, Layers, ListFilter, MapPin, Pentagon, Search, Spline, Square, X } from "lucide-react";
import { AoiInspector, type InspectorPerms } from "@/components/map/aoi-inspector";
import { api, ApiError, orgApi } from "@/components/map/api";
import { DetectionInspector } from "@/components/map/detection-inspector";
import { EventInspector, type SelectedEvent } from "@/components/map/event-inspector";
import { DETECTION_COLORS, DetectionLegend, RasterLegend } from "@/components/map/legend";
import { MapView, type DrawMode, type MapHandle, type RasterOverlay } from "@/components/map/map-view";
import { NewAoiPanel } from "@/components/map/new-aoi-panel";
import { ScenesPanel, type SavedScene } from "@/components/map/scenes-panel";
import { ObservationMeta } from "@/components/map/observation-meta";
import type { Aoi, AoiFeatureProps, Detection, DetectionFeatureProps, FC, Observation } from "@/components/map/types";
import { Badge, Button, inputClass, Notice } from "@/components/platform/ui";
import { AOI_KIND_LABEL, type AoiKind } from "@/lib/aoi-config";
import { cn } from "@/lib/cn";
import { formatDate, relativeTime } from "@/lib/format";
import { bboxOf, formatArea, metersPerPixel, parseCoordinates, type Geometry, type PolygonGeometry } from "@/lib/geo";
import type { MapBasemap, MapOverlay } from "@/lib/map-layer-types";
import { FEED_STATE_LABEL, PUBLIC_EVENT_LAYER_IDS, PUBLIC_EVENT_LAYERS, type FeedState, type PublicEventLayerId, type PublicEventsResponse } from "@/lib/public-events";
import { SCENE_IMAGERY_KINDS, SCENE_VERIFICATION, type ScenePreset, type SceneState, type SceneStateInput } from "@/lib/scenes";

type Filters = { verification: (typeof SCENE_VERIFICATION)[number][]; minGrade: "" | "weak" | "moderate" | "strong"; types: string[]; days: number };
// Weak candidates are numerous and mostly noise (season, haze, mask edges); they are one click away.
const DEFAULT_FILTERS: Filters = { verification: ["unverified", "needs_field_check", "confirmed"], minGrade: "moderate", types: [], days: 365 };
type SceneImagery = NonNullable<SceneState["imagery"]>;
const isSceneImageryKind = (k: string): k is SceneImagery["kind"] => (SCENE_IMAGERY_KINDS as readonly string[]).includes(k);
const IMAGERY_PREF = ["ndvi", "ndmi", "s1_water", "ndwi", "landcover"];
type EventDays = 1 | 7 | 30;
const FEED_TONE: Record<FeedState, "good" | "info" | "watch" | "alert" | "muted"> = { nominal: "good", loading: "muted", partial: "info", stale: "watch", unavailable: "alert", disabled: "muted" };
const wrapLon = (x: number) => ((((x + 180) % 360) + 360) % 360) - 180;
/** The request box for public events: the view padded by a quarter, wrapped to ±180, rounded so small pans reuse it. */
function eventBoxFor(b: [number, number, number, number] | null): string | null {
  if (!b) return null;
  const dx = (b[2] - b[0]) / 4;
  const dy = (b[3] - b[1]) / 4;
  const s = Math.max(-90, b[1] - dy);
  const n = Math.min(90, b[3] + dy);
  const r = (v: number) => Math.round(v * 100) / 100;
  if (b[2] - b[0] + 2 * dx >= 359.9) return `-180,${r(s)},180,${r(n)}`;
  return [wrapLon(b[0] - dx), s, wrapLon(b[2] + dx), n].map(r).join(",");
}

export type WorkspaceProps = {
  slug: string;
  orgKind: string;
  timeZone: string;
  perms: InspectorPerms;
  basemaps: MapBasemap[];
  overlays: MapOverlay[];
  initialAois: FC<AoiFeatureProps>;
  initialBounds: [number, number, number, number] | null;
  /** Explicit starting view (e.g. coming from the 3D globe); wins over initialBounds. */
  initialView?: { center: [number, number]; zoom: number } | null;
  focus: { aoi?: string; detection?: string; obs?: string; draw?: boolean };
};

export function MapWorkspace(props: WorkspaceProps) {
  const { slug, timeZone, perms } = props;
  const router = useRouter();
  const mapRef = useRef<MapHandle>(null);
  const primary = useRef<MlMap | null>(null);
  const secondary = useRef<MlMap | null>(null);

  const [aois, setAois] = useState(props.initialAois);
  const [detections, setDetections] = useState<FC<DetectionFeatureProps> | null>(null);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [selAoi, setSelAoi] = useState<string | null>(props.focus.aoi ?? null);
  const [selDet, setSelDet] = useState<string | null>(props.focus.detection ?? null);
  const [active, setActive] = useState<Observation | null>(null);
  const [layer, setLayer] = useState<"index" | "true_color">("index");
  const [opacity, setOpacity] = useState(0.85);
  const [compare, setCompare] = useState<Observation | null>(null);
  /** ΔNDVI map of a candidate change's comparison, shown instead of the observation raster. */
  const [changeMap, setChangeMap] = useState<{ detectionId: string; url: string; corners: NonNullable<Observation["corners"]>; legend: NonNullable<Observation["legend"]>; label: string } | null>(null);
  const [swipe, setSwipe] = useState(50);
  const [timeline, setTimeline] = useState<Observation[]>([]);
  const [drawMode, setDrawMode] = useState<DrawMode | null>(props.focus.draw && perms.write ? "polygon" : null);
  const [draft, setDraft] = useState<Geometry | null>(null);
  const [edit, setEdit] = useState<{ aoi: Aoi; geom: PolygonGeometry } | null>(null);
  const [basemapId, setBasemapId] = useState(props.basemaps[0]?.id ?? "");
  const [overlayIds, setOverlayIds] = useState<string[]>([]);
  const [showAois, setShowAois] = useState(true);
  const [showDetections, setShowDetections] = useState(true);
  const [view, setView] = useState<{ zoom: number; center: [number, number]; bounds: [number, number, number, number] } | null>(null);
  const [eventIds, setEventIds] = useState<PublicEventLayerId[]>([]);
  const [eventDays, setEventDays] = useState<EventDays>(7);
  const [eventData, setEventData] = useState<Partial<Record<PublicEventLayerId, { key: string; res: PublicEventsResponse | null; error: string | null }>>>({});
  const [selEvent, setSelEvent] = useState<SelectedEvent | null>(null);
  const [leftOpen, setLeftOpen] = useState(true);
  const [tab, setTab] = useState<"areas" | "layers" | "changes" | "scenes">("areas");
  const [projection, setProjection] = useState<"mercator" | "globe">("mercator");
  const [chartIndex, setChartIndex] = useState<"ndvi" | "ndmi">("ndvi");
  /** Area whose observations are in `timeline` (null while loading). */
  const [timelineAoi, setTimelineAoi] = useState<string | null>(null);
  /** Image a restored scene asked for, resolved once that area's observations load. */
  const pendingImagery = useRef<(SceneImagery & { aoiId: string }) | null>(null);
  const [query, setQuery] = useState("");
  type SearchHit = { label: string; position: [number, number]; bbox?: [number, number, number, number]; aoiId?: string; source: string };
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refLayers, setRefLayers] = useState<{ id: string; name: string; kind: string; featureCount: number; attribution: string | null }[]>([]);
  const [refData, setRefData] = useState<{ id: string; data: GeoJSON.FeatureCollection }[]>([]);

  useEffect(() => {
    let cancelled = false;
    api<{ items: { id: string; name: string; kind: string; featureCount: number; attribution: string | null }[] }>(`${orgApi(slug)}/reference-layers`)
      .then((r) => !cancelled && setRefLayers(r.items))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const eventBox = eventBoxFor(view?.bounds ?? null);
  const eventKey = `${eventBox}|${eventDays}`;
  useEffect(() => {
    if (!eventBox || eventIds.length === 0) return;
    let cancelled = false;
    const key = `${eventBox}|${eventDays}`;
    for (const id of eventIds) {
      const qs = new URLSearchParams({ bbox: eventBox });
      if (PUBLIC_EVENT_LAYERS[id].windows) qs.set("days", String(eventDays));
      api<PublicEventsResponse>(`${orgApi(slug)}/public-events/${id}?${qs}`)
        .then((res) => !cancelled && setEventData((d) => ({ ...d, [id]: { key, res, error: null } })))
        .catch((e: unknown) => {
          if (!cancelled) setEventData((d) => ({ ...d, [id]: { key, res: d[id]?.res ?? null, error: e instanceof ApiError ? e.message : "Could not load this layer." } }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [slug, eventIds, eventBox, eventDays]);

  const mapEvents = useMemo(
    () => eventIds.flatMap((id) => (eventData[id]?.res ? [{ id: id as string, data: eventData[id]!.res!.features as GeoJSON.FeatureCollection }] : [])),
    [eventIds, eventData],
  );

  /** One honest state per enabled feed (the server's, unless this browser's request failed or is in flight). */
  const eventState = (id: PublicEventLayerId): FeedState => {
    const d = eventData[id];
    if (!d || (d.key !== eventKey && !d.res)) return "loading";
    if (d.error) return d.res ? "stale" : "unavailable";
    return d.res?.feed.state ?? "loading";
  };

  function selectEvent(layer: string, id: string) {
    const res = eventData[layer as PublicEventLayerId]?.res;
    const f = res?.features.features.find((x) => x.properties.id === id);
    if (!f || !res) return;
    setSelDet(null);
    setSelEvent({ props: f.properties, geometry: f.geometry, feed: res.feed });
  }

  async function toggleReference(id: string, on: boolean) {
    if (!on) return setRefData((d) => d.filter((x) => x.id !== id));
    try {
      const fc = await api<GeoJSON.FeatureCollection>(`${orgApi(slug)}/reference-layers/${id}`);
      setRefData((d) => [...d.filter((x) => x.id !== id), { id, data: fc }]);
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : "Could not load the layer.");
    }
  }

  const basemap = props.basemaps.find((b) => b.id === basemapId) ?? props.basemaps[0]!;
  const overlays = useMemo(() => props.overlays.filter((o) => overlayIds.includes(o.id)), [props.overlays, overlayIds]);

  // URL reflects the current selection so alerts and links can deep-link.
  useEffect(() => {
    const p = new URLSearchParams();
    if (selAoi) p.set("aoi", selAoi);
    if (selDet) p.set("detection", selDet);
    if (active) p.set("obs", active.id);
    const qs = p.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  }, [selAoi, selDet, active, router]);

  const refreshAois = useCallback(async () => {
    try {
      setAois(await api<FC<AoiFeatureProps>>(`${orgApi(slug)}/aois`));
    } catch {
      setNotice("Could not refresh areas.");
    }
  }, [slug]);

  const [detectionsVersion, setDetectionsVersion] = useState(0);
  const refreshDetections = useCallback(() => setDetectionsVersion((v) => v + 1), []);

  useEffect(() => {
    let cancelled = false;
    const q = new URLSearchParams();
    if (filters.verification.length) q.set("verification", filters.verification.join(","));
    if (filters.minGrade) q.set("minGrade", filters.minGrade);
    if (filters.types.length) q.set("type", filters.types.join(","));
    if (filters.days) q.set("withinDays", String(filters.days));
    api<FC<DetectionFeatureProps>>(`${orgApi(slug)}/detections?${q}`)
      .then((fc) => !cancelled && setDetections(fc))
      .catch(() => !cancelled && setNotice("Could not load detections."));
    return () => {
      cancelled = true;
    };
  }, [slug, filters, detectionsVersion]);

  // Deep link to an observation.
  useEffect(() => {
    if (!props.focus.obs) return;
    api<Observation>(`${orgApi(slug)}/observations/${props.focus.obs}`)
      .then((o) => setActive(o))
      .catch(() => setNotice("The linked observation is not available."));
  }, [slug, props.focus.obs]);

  const zoomToAoi = useCallback(
    (id: string) => {
      const f = aois.features.find((x) => x.properties.id === id);
      if (f) mapRef.current?.fitBounds(bboxOf(f.geometry as Geometry), { maxZoom: 15 });
    },
    [aois],
  );

  const selectAoi = (id: string, zoom = true) => {
    setSelAoi(id);
    setSelDet(null);
    setSelEvent(null);
    if (id !== selAoi) {
      setActive(null);
      setCompare(null);
      setTimeline([]);
      setTimelineAoi(null);
    }
    if (zoom) zoomToAoi(id);
  };

  const selectDetection = (id: string) => {
    setSelEvent(null);
    setSelDet(id);
  };

  // Keep the comparison map's camera locked to the primary map.
  useEffect(() => {
    const p = primary.current;
    if (!p || !compare) return;
    const sync = () => secondary.current?.jumpTo({ center: p.getCenter(), zoom: p.getZoom(), bearing: p.getBearing(), pitch: p.getPitch() });
    p.on("move", sync);
    sync();
    return () => {
      p.off("move", sync);
    };
  }, [compare]);

  const rasterFor = (o: Observation | null, l: "index" | "true_color"): RasterOverlay | null => {
    if (!o || !o.corners) return null;
    const useLayer = l === "true_color" && o.hasTrueColor ? "true_color" : "index";
    return { url: `${orgApi(slug)}/observations/${o.id}/raster?layer=${useLayer}`, corners: o.corners, opacity };
  };

  const primaryRaster: RasterOverlay | null = changeMap ? { url: changeMap.url, corners: changeMap.corners, opacity } : rasterFor(active, layer);
  /** Show one observation on the map (clears any comparison or change map). */
  const showObservation = (o: Observation | null) => {
    setChangeMap(null);
    setCompare(null);
    setActive(o);
  };

  /** Show the saved image from this area's own (permission-checked) observation list, or say it is gone. */
  const resolveImagery = (want: SceneImagery, obs: Observation[]) => {
    const t = Date.parse(want.observedAt);
    const o = obs.find((x) => x.kind === want.kind && Date.parse(x.observedAt) === t && x.status === "valid" && x.hasRaster);
    if (o) {
      setLayer(want.layer);
      showObservation(o);
    } else {
      showObservation(null);
      setNotice(`The scene's ${want.kind.toUpperCase()} image of ${formatDate(want.observedAt, timeZone)} is no longer available for this area; the rest of the view was restored.`);
    }
  };

  const captureScene = (): SceneStateInput | null => {
    const m = mapRef.current?.map();
    if (!m) return null;
    const c = m.getCenter().wrap();
    const round = (v: number, d = 6) => Math.round(v * 10 ** d) / 10 ** d;
    return {
      view: { center: [round(c.lng), round(Math.max(-85.05, Math.min(85.05, c.lat)))], zoom: round(m.getZoom(), 2), bearing: round(m.getBearing(), 1), pitch: round(m.getPitch(), 1) },
      projection,
      basemap: basemap.id,
      overlays: overlayIds,
      showAois,
      showDetections,
      publicEvents: eventIds,
      eventDays,
      aoiId: selAoi,
      imagery: active && !changeMap && isSceneImageryKind(active.kind) ? { kind: active.kind, observedAt: active.observedAt, layer } : null,
      chartIndex,
      changes: filters,
    };
  };

  function applyScene(scene: SavedScene) {
    const st = scene.state;
    setDrawMode(null);
    setDraft(null);
    setEdit(null);
    setSelDet(null);
    if (st.basemap && props.basemaps.some((b) => b.id === st.basemap)) setBasemapId(st.basemap);
    setOverlayIds(st.overlays.filter((id) => props.overlays.some((o) => o.id === id)));
    setShowAois(st.showAois);
    setShowDetections(st.showDetections);
    setEventIds(st.publicEvents);
    setEventDays(st.eventDays);
    setSelEvent(null);
    setProjection(st.projection);
    setChartIndex(st.chartIndex);
    if (st.changes) setFilters(st.changes);
    mapRef.current?.map()?.jumpTo({ center: st.view.center, zoom: st.view.zoom, bearing: st.view.bearing, pitch: st.view.pitch });
    pendingImagery.current = null;
    if (st.aoiId && aois.features.some((f) => f.properties.id === st.aoiId)) {
      const sameArea = st.aoiId === selAoi && timelineAoi === selAoi;
      selectAoi(st.aoiId, false);
      if (!st.imagery) showObservation(null);
      else if (sameArea) resolveImagery(st.imagery, timeline);
      else pendingImagery.current = { ...st.imagery, aoiId: st.aoiId };
    } else {
      setSelAoi(null);
      setTimeline([]);
      setTimelineAoi(null);
      showObservation(null);
      if (scene.aoiUnavailable || st.aoiId) setNotice("The scene's area is not available to you; the rest of the view was restored.");
    }
  }

  function applyPreset(p: ScenePreset) {
    const a = p.apply;
    if (a.basemap && props.basemaps.some((b) => b.id === a.basemap)) setBasemapId(a.basemap);
    if (a.overlays) setOverlayIds(a.overlays.filter((id) => props.overlays.some((o) => o.id === id)));
    if (a.showAois !== undefined) setShowAois(a.showAois);
    if (a.showDetections !== undefined) setShowDetections(a.showDetections);
    if (a.changes) setFilters(a.changes);
    if (a.chartIndex) {
      setChartIndex(a.chartIndex);
      if (a.chartIndex === "ndmi" && timelineAoi && !timeline.some((o) => o.kind === "ndmi" && o.status === "valid")) {
        setNotice("This area has no usable NDMI image yet, so the chart stays on NDVI. NDMI needs Sentinel-2's 20 m short-wave infrared band.");
      }
    }
    if (a.latestImagery) {
      const usable = timeline.filter((o) => o.status === "valid" && o.hasRaster);
      const kind = IMAGERY_PREF.find((k) => usable.some((o) => o.kind === k));
      const latest = usable.filter((o) => o.kind === kind).sort((x, y) => Date.parse(y.observedAt) - Date.parse(x.observedAt))[0];
      if (latest) showObservation(latest);
      else setNotice(timelineAoi ? "This area has no usable satellite image yet." : "The area's images are still loading; try again in a moment.");
    }
  }

  /** Drawing and boundary editing always use the flat map. */
  const mapProjection = projection === "globe" && !drawMode && !edit && !draft ? "globe" : "mercator";

  const gsd = active?.asset.gsdM ?? active?.quality.gsd_m ?? null;
  const mpp = view ? metersPerPixel(view.zoom, view.center[1]) : null;
  const beyondResolution = active && gsd && mpp ? mpp < gsd / 2 : false;

  async function saveEdit() {
    if (!edit) return;
    try {
      await api(`${orgApi(slug)}/aois/${edit.aoi.id}`, { method: "PATCH", json: { geometry: edit.geom } });
      setEdit(null);
      await refreshAois();
      setNotice("Boundary updated. A new imagery search was queued; earlier results remain in the history and were computed with the previous boundary.");
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : "Could not save the boundary.");
    }
  }

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    const coords = parseCoordinates(q);
    if (coords) {
      mapRef.current?.flyTo(coords, 15);
      setResults(null);
      return;
    }
    const local: SearchHit[] = aois.features
      .filter((f) => f.properties.name.toLowerCase().includes(q.toLowerCase()))
      .slice(0, 5)
      .map((f) => ({ label: f.properties.name, position: [0, 0] as [number, number], bbox: bboxOf(f.geometry as Geometry), aoiId: f.properties.id, source: "Saved area" }));
    let remote: SearchHit[] = [];
    try {
      const r = await api<{ items: { label: string; position: [number, number]; bbox?: [number, number, number, number]; source: string }[] }>(`${orgApi(slug)}/geocode?q=${encodeURIComponent(q)}`);
      remote = r.items;
    } catch (err) {
      if (local.length === 0) setNotice(err instanceof ApiError ? err.message : "Search is unavailable.");
    }
    setResults([...local, ...remote]);
  }

  const parents = aois.features.filter((f) => f.properties.kind === "farm" || f.properties.kind === "municipal_boundary" || f.properties.kind === "region").map((f) => ({ id: f.properties.id, name: f.properties.name }));
  const timelineKind = active?.kind ?? (timeline.some((o) => o.kind === "ndvi") ? "ndvi" : timeline[0]?.kind);
  const timelineObs = timeline.filter((o) => o.kind === timelineKind && o.hasRaster).sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const sortedAois = [...aois.features].sort((a, b) => a.properties.name.localeCompare(b.properties.name));
  const detList = detections?.features ?? [];

  return (
    <div className="relative flex h-full min-h-0">
      {/* Left panel */}
      <aside className={cn("absolute inset-y-0 left-0 z-20 flex w-[300px] max-w-[85vw] flex-col border-r border-bone-50/[0.08] bg-ink-950/95 backdrop-blur transition-transform lg:static lg:translate-x-0", leftOpen ? "translate-x-0" : "-translate-x-full lg:hidden")}>
        <form onSubmit={runSearch} className="flex items-center gap-2 border-b border-bone-50/[0.08] p-3" role="search">
          <Search className="size-4 shrink-0 text-bone-50/45" aria-hidden="true" />
          <input aria-label="Search places, addresses, coordinates, or saved areas" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Place, address, lat, lon, or area" className="min-w-0 flex-1 bg-transparent text-[0.8125rem] placeholder:text-bone-50/30 focus:outline-none" />
        </form>
        {results ? (
          <div className="border-b border-bone-50/[0.08] p-2">
            {results.length === 0 ? <p className="px-1 text-[0.75rem] text-bone-50/50">No matches.</p> : null}
            {results.map((r, i) => (
              <button
                key={i}
                className="block w-full rounded-[2px] px-2 py-1.5 text-left text-[0.75rem] hover:bg-bone-50/[0.05]"
                onClick={() => {
                  if (r.aoiId) selectAoi(r.aoiId);
                  else if (r.bbox) mapRef.current?.fitBounds(r.bbox, { maxZoom: 16 });
                  else mapRef.current?.flyTo(r.position, 16);
                  setResults(null);
                }}
              >
                <span className="block text-bone-50/85">{r.label}</span>
                <span className="text-bone-50/40">{r.source}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div role="tablist" aria-label="Workspace panels" className="flex border-b border-bone-50/[0.08] text-[0.75rem]">
          {(["areas", "layers", "changes", "scenes"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn("flex-1 py-2 capitalize", tab === t ? "border-b border-signal text-bone-50" : "text-bone-50/55 hover:text-bone-50")}>
              {t === "changes" ? `Changes (${detList.length})` : t}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === "areas" ? (
            <div className="flex flex-col">
              {perms.write ? (
                <div className="flex flex-wrap gap-1 border-b border-bone-50/[0.06] p-2">
                  <p className="w-full px-1 pb-1 text-[0.6875rem] text-bone-50/45">Draw a new area</p>
                  {([
                    ["polygon", Pentagon, "Polygon"],
                    ["rectangle", Square, "Rectangle"],
                    ["point", MapPin, "Point"],
                    ["linestring", Spline, "Corridor"],
                  ] as const).map(([m, Icon, label]) => (
                    <Button key={m} size="sm" variant={drawMode === m ? "primary" : "secondary"} onClick={() => { setDraft(null); setEdit(null); setDrawMode(drawMode === m ? null : m); }}>
                      <Icon className="size-3.5" aria-hidden="true" /> {label}
                    </Button>
                  ))}
                </div>
              ) : null}
              {sortedAois.length === 0 ? <p className="p-4 text-[0.75rem] text-bone-50/50">No areas yet.{perms.write ? " Draw one on the map to start monitoring." : ""}</p> : null}
              <ul>
                {sortedAois.map((f) => (
                  <li key={f.properties.id}>
                    <button onClick={() => selectAoi(f.properties.id)} className={cn("flex w-full items-start justify-between gap-2 border-b border-bone-50/[0.05] px-3 py-2 text-left hover:bg-bone-50/[0.03]", selAoi === f.properties.id && "bg-bone-50/[0.06]")}>
                      <span className="min-w-0">
                        <span className="block truncate text-[0.8125rem]">{f.properties.name}</span>
                        <span className="block text-[0.6875rem] text-bone-50/45">{AOI_KIND_LABEL[f.properties.kind as AoiKind] ?? f.properties.kind} · {formatArea(f.properties.area_m2)}</span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        {f.properties.open_alerts ? <Badge tone="alert">{f.properties.open_alerts} alert{f.properties.open_alerts > 1 ? "s" : ""}</Badge> : null}
                        {f.properties.unreviewed_detections ? <Badge tone="watch">{f.properties.unreviewed_detections} to review</Badge> : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : tab === "scenes" ? (
            <ScenesPanel slug={slug} timeZone={timeZone} canShare={perms.notes} hasArea={Boolean(selAoi)} capture={captureScene} onApply={applyScene} onPreset={applyPreset} />
          ) : tab === "layers" ? (
            <div className="flex flex-col gap-5 p-3 text-[0.8125rem]">
              <fieldset>
                <legend className="t-eyebrow mb-2 text-bone-50/45">View</legend>
                {([
                  ["mercator", "Flat map (2D)", "For field boundaries, imagery, and measurement."],
                  ["globe", "Globe (3D overview)", "Global context at low zoom; it flattens as you zoom in. Drawing and editing switch to the flat map."],
                ] as const).map(([v, label, note]) => (
                  <label key={v} className="flex items-start gap-2 py-1">
                    <input type="radio" name="projection" className="mt-1" checked={projection === v} onChange={() => setProjection(v)} />
                    <span><span className="block">{label}</span><span className="block text-[0.6875rem] text-bone-50/45">{note}</span></span>
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend className="t-eyebrow mb-2 text-bone-50/45">Basemap</legend>
                {props.basemaps.map((b) => (
                  <label key={b.id} className="flex items-start gap-2 py-1">
                    <input type="radio" name="basemap" checked={basemapId === b.id} onChange={() => setBasemapId(b.id)} className="mt-1" disabled={Boolean(drawMode || edit)} />
                    <span>
                      <span className="block">{b.label}</span>
                      <span className="block text-[0.6875rem] text-bone-50/45">{b.attribution}</span>
                      {b.notes ? <span className="block text-[0.6875rem] text-bone-50/45">{b.notes}</span> : null}
                    </span>
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend className="t-eyebrow mb-2 text-bone-50/45">Overlays</legend>
                {props.overlays.map((o) => (
                  <label key={o.id} className="flex items-start gap-2 py-1">
                    <input type="checkbox" className="mt-1" checked={overlayIds.includes(o.id)} onChange={(e) => setOverlayIds((ids) => (e.target.checked ? [...ids, o.id] : ids.filter((i) => i !== o.id)))} />
                    <span><span className="block">{o.label}</span><span className="block text-[0.6875rem] text-bone-50/45">{o.notes ?? o.attribution}</span></span>
                  </label>
                ))}
                <label className="flex items-center gap-2 py-1"><input type="checkbox" checked={showAois} onChange={(e) => setShowAois(e.target.checked)} /> Areas of interest</label>
                <label className="flex items-center gap-2 py-1"><input type="checkbox" checked={showDetections} onChange={(e) => setShowDetections(e.target.checked)} /> Candidate changes</label>
              </fieldset>
              {/* min-w-0: a fieldset otherwise grows to its longest (truncated) row and the panel scrolls sideways. */}
              <fieldset className="min-w-0">
                <legend className="t-eyebrow mb-2 text-bone-50/45">Public events</legend>
                <p className="mb-1 text-[0.6875rem] text-bone-50/45">Public records shown for context — not ORYN findings, and never added to alerts automatically.</p>
                {PUBLIC_EVENT_LAYER_IDS.map((id) => {
                  const l = PUBLIC_EVENT_LAYERS[id];
                  const on = eventIds.includes(id);
                  const d = eventData[id];
                  const st = on ? eventState(id) : null;
                  return (
                    <div key={id} className="py-1">
                      <label className="flex items-start gap-2">
                        <input type="checkbox" className="mt-1" checked={on} onChange={(e) => setEventIds((ids) => (e.target.checked ? [...ids, id] : ids.filter((x) => x !== id)))} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-1.5">
                              {l.geometry === "point" ? (
                                <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="none" stroke="#f2f1ed" strokeWidth="1.5" /></svg>
                              ) : (
                                <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><rect x="0.75" y="0.75" width="10.5" height="10.5" fill="none" stroke="#f2f1ed" strokeWidth="1.25" /><path d="M0 6 6 0M0 12 12 0M6 12 12 6" stroke="#f2f1ed" strokeOpacity="0.6" /></svg>
                              )}
                              {l.name}
                            </span>
                            {st ? <Badge tone={FEED_TONE[st]}>{FEED_STATE_LABEL[st]}</Badge> : null}
                          </span>
                          <span className="block text-[0.6875rem] text-bone-50/45">
                            {l.geometry === "point" ? "Ring size = magnitude · " : "Hatched = reported perimeter · "}
                            {l.attribution}
                          </span>
                          {on && d?.res && d.res.feed.state !== "disabled" && d.res.feed.state !== "unavailable" ? (
                            <span className="block text-[0.6875rem] text-bone-50/45">
                              {d.res.total} in view{d.res.feed.retrievedAt ? ` · retrieved ${relativeTime(d.res.feed.retrievedAt)}` : ""}
                            </span>
                          ) : null}
                          {on && (d?.error || d?.res?.feed.message) ? <span className="block text-[0.6875rem] text-data-amber">{d?.error ?? d?.res?.feed.message}</span> : null}
                        </span>
                      </label>
                      {on && d?.res && d.res.features.features.length ? (
                        <ul className="ml-6 mt-1" aria-label={`${l.name} in view`}>
                          {d.res.features.features.slice(0, 5).map((f) => (
                            <li key={f.properties.id}>
                              <button
                                className={cn("block w-full truncate rounded-[2px] px-1 py-0.5 text-left text-[0.75rem] text-bone-50/75 hover:bg-bone-50/[0.05]", selEvent?.props.id === f.properties.id && "text-signal")}
                                onClick={() => selectEvent(id, f.properties.id)}
                              >
                                {f.properties.layer === "usgs-earthquakes"
                                  ? `M${f.properties.magnitude.toFixed(1)} · ${f.properties.place ?? "Unknown place"}`
                                  : `${f.properties.title}${f.properties.acres !== null ? ` · ${Math.round(f.properties.acres).toLocaleString("en-US")} ac` : ""}`}
                                {f.properties.observedAt ? <span className="text-bone-50/40"> · {relativeTime(f.properties.observedAt)}</span> : null}
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {on && l.windows ? (
                        <label className="ml-6 mt-1 flex items-center gap-2 text-[0.75rem] text-bone-50/60">
                          Past
                          <select className={cn(inputClass, "w-auto py-0.5 text-[0.75rem]")} value={eventDays} onChange={(e) => setEventDays(Number(e.target.value) as EventDays)}>
                            {l.windows.map((w) => <option key={w} value={w}>{w === 1 ? "24 hours" : `${w} days`}</option>)}
                          </select>
                        </label>
                      ) : null}
                    </div>
                  );
                })}
              </fieldset>
              <fieldset>
                <legend className="t-eyebrow mb-2 text-bone-50/45">Reference layers</legend>
                {refLayers.length === 0 ? <p className="text-[0.75rem] text-bone-50/45">None yet. Import OpenStreetMap context or upload permits/parcels from an area&apos;s page.</p> : null}
                {refLayers.map((l) => (
                  <label key={l.id} className="flex items-start gap-2 py-1">
                    <input type="checkbox" className="mt-1" checked={refData.some((d) => d.id === l.id)} onChange={(e) => toggleReference(l.id, e.target.checked)} />
                    <span><span className="block">{l.name}</span><span className="block text-[0.6875rem] text-bone-50/45">{l.kind} · {l.featureCount} features{l.attribution ? ` · ${l.attribution}` : ""}</span></span>
                  </label>
                ))}
              </fieldset>
              <div>
                <p className="t-eyebrow mb-2 text-bone-50/45">Change legend</p>
                <DetectionLegend />
              </div>
            </div>
          ) : (
            <div className="flex flex-col">
              <div className="flex flex-col gap-2 border-b border-bone-50/[0.06] p-3 text-[0.75rem]">
                <p className="flex items-center gap-1.5 text-bone-50/55"><ListFilter className="size-3.5" aria-hidden="true" /> Filters apply to the map and this list</p>
                <label className="flex items-center justify-between gap-2">Period
                  <select className={cn(inputClass, "w-auto py-0.5 text-[0.75rem]")} value={filters.days} onChange={(e) => setFilters({ ...filters, days: Number(e.target.value) })}>
                    <option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={180}>Last 180 days</option><option value={365}>Last year</option><option value={0}>All time</option>
                  </select>
                </label>
                <label className="flex items-center justify-between gap-2">Minimum evidence
                  <select className={cn(inputClass, "w-auto py-0.5 text-[0.75rem]")} value={filters.minGrade} onChange={(e) => setFilters({ ...filters, minGrade: e.target.value as Filters["minGrade"] })}>
                    <option value="">Any</option><option value="weak">Weak+</option><option value="moderate">Moderate+</option><option value="strong">Strong</option>
                  </select>
                </label>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {(["unverified", "needs_field_check", "confirmed", "dismissed"] as const).map((v) => (
                    <label key={v} className="flex items-center gap-1">
                      <input type="checkbox" checked={filters.verification.includes(v)} onChange={(e) => setFilters({ ...filters, verification: e.target.checked ? [...filters.verification, v] : filters.verification.filter((x) => x !== v) })} />
                      {v.replace(/_/g, " ")}
                    </label>
                  ))}
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {Object.entries(DETECTION_COLORS).filter(([t]) => t !== "other").map(([t, v]) => (
                    <label key={t} className="flex items-center gap-1">
                      <input type="checkbox" checked={filters.types.length === 0 || filters.types.includes(t)} onChange={(e) => {
                        const all = Object.keys(DETECTION_COLORS).filter((x) => x !== "other");
                        const cur = filters.types.length ? filters.types : all;
                        const next = e.target.checked ? [...cur, t] : cur.filter((x) => x !== t);
                        setFilters({ ...filters, types: next.length === all.length ? [] : next });
                      }} />
                      <span aria-hidden="true" className="size-2 rounded-[1px]" style={{ background: v.color }} />{v.label.replace(" (candidate)", "")}
                    </label>
                  ))}
                </div>
              </div>
              {detList.length === 0 ? <p className="p-4 text-[0.75rem] text-bone-50/50">No candidate changes match these filters.</p> : null}
              <ul>
                {detList.map((f) => (
                  <li key={f.properties.id}>
                    <button onClick={() => selectDetection(f.properties.id)} className={cn("flex w-full flex-col gap-0.5 border-b border-bone-50/[0.05] px-3 py-2 text-left hover:bg-bone-50/[0.03]", selDet === f.properties.id && "bg-bone-50/[0.06]")}>
                      <span className="flex items-center gap-2 text-[0.8125rem]">
                        <span aria-hidden="true" className="size-2 shrink-0 rounded-[1px]" style={{ background: (DETECTION_COLORS[f.properties.type] ?? DETECTION_COLORS.other!).color }} />
                        <span className="truncate">{f.properties.title}</span>
                      </span>
                      <span className="text-[0.6875rem] text-bone-50/45">
                        {f.properties.aoi_name} · {f.properties.comparison_observed_at ? formatDate(f.properties.comparison_observed_at, timeZone) : "—"} · {f.properties.evidence_grade} evidence · {f.properties.verification_status.replace(/_/g, " ")}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </aside>

      {/* Map */}
      <div className="relative min-w-0 flex-1">
        <MapView
          ref={mapRef}
          className="absolute inset-0"
          ariaLabel="Geospatial workspace map"
          basemap={basemap}
          overlays={overlays}
          projection={mapProjection}
          events={mapEvents}
          selectedEventId={selEvent?.props.id ?? null}
          onEventClick={selectEvent}
          aois={aois}
          detections={detections}
          showAois={showAois}
          showDetections={showDetections}
          selectedAoiId={selAoi}
          selectedDetectionId={selDet}
          raster={primaryRaster}
          references={refData}
          initialBounds={props.initialBounds}
          initialView={props.initialView ?? null}
          drawMode={draft ? null : drawMode}
          editGeometry={edit?.geom ?? null}
          onDrawFinish={(g) => setDraft(g)}
          onEditChange={(g) => setEdit((e) => (e ? { ...e, geom: g } : e))}
          onAoiClick={(id) => selectAoi(id, false)}
          onDetectionClick={selectDetection}
          onView={(v) => setView(v)}
          onReady={(m) => {
            primary.current = m;
          }}
        />
        {compare ? (
          <>
            <div className="pointer-events-none absolute inset-0" style={{ clipPath: `inset(0 0 0 ${swipe}%)` }} aria-hidden="true">
              <MapView
                className="absolute inset-0"
                interactive={false}
                projection={mapProjection}
                basemap={basemap}
                overlays={[]}
                aois={aois}
                detections={detections}
                showAois={showAois}
                showDetections={showDetections}
                selectedAoiId={selAoi}
                selectedDetectionId={selDet}
                raster={rasterFor(compare, layer)}
                initialBounds={props.initialBounds}
                onReady={(m) => {
                  secondary.current = m;
                  const p = primary.current;
                  if (p) m.jumpTo({ center: p.getCenter(), zoom: p.getZoom() });
                }}
              />
            </div>
            <div className="absolute inset-y-0 z-10 w-0.5 bg-signal" style={{ left: `${swipe}%` }}>
              <div
                role="slider"
                tabIndex={0}
                aria-label="Comparison divider"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(swipe)}
                className="absolute top-1/2 -ml-3 flex h-10 w-6 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-[3px] bg-signal text-[0.625rem] text-ink-950"
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft") setSwipe((s) => Math.max(0, s - 2));
                  if (e.key === "ArrowRight") setSwipe((s) => Math.min(100, s + 2));
                }}
                onPointerDown={(e) => {
                  const el = e.currentTarget.parentElement!.parentElement!;
                  const rect = el.getBoundingClientRect();
                  const move = (ev: PointerEvent) => setSwipe(Math.min(100, Math.max(0, ((ev.clientX - rect.left) / rect.width) * 100)));
                  const up = () => {
                    window.removeEventListener("pointermove", move);
                    window.removeEventListener("pointerup", up);
                  };
                  window.addEventListener("pointermove", move);
                  window.addEventListener("pointerup", up);
                }}
              >
                ⇔
              </div>
            </div>
            <div className="pointer-events-none absolute left-3 top-14 z-10 rounded-[3px] bg-ink-950/90 px-2 py-1 text-[0.6875rem]">A · {active ? formatDate(active.observedAt, timeZone) : "—"}</div>
            <div className="pointer-events-none absolute right-14 top-14 z-10 rounded-[3px] bg-ink-950/90 px-2 py-1 text-[0.6875rem]">B · {formatDate(compare.observedAt, timeZone)}</div>
          </>
        ) : null}

        {/* Map chrome */}
        <div className="absolute left-3 top-3 z-10 flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" className="bg-ink-950/90 lg:hidden" onClick={() => setLeftOpen((o) => !o)} aria-expanded={leftOpen}>
              <Layers className="size-3.5" aria-hidden="true" /> Panel
            </Button>
            <Link
              href={`/app/${slug}/intel${view ? `?at=${view.center[0].toFixed(4)},${view.center[1].toFixed(4)},${Math.round(35_000_000 / 2 ** view.zoom) + 2_000}` : ""}`}
              className="inline-flex items-center gap-1.5 rounded-[3px] border border-bone-50/20 bg-ink-950/90 px-2.5 py-1 text-[0.75rem] hover:border-bone-50/50"
            >
              <Globe2 className="size-3.5" aria-hidden="true" /> 3D intelligence globe
            </Link>
          </div>
          {drawMode && !draft ? (
            <div className="max-w-xs rounded-[3px] border border-signal/40 bg-ink-950/95 px-3 py-2 text-[0.75rem]">
              {drawMode === "polygon" ? "Click to add vertices; click the first point (or press Enter) to finish." : drawMode === "rectangle" ? "Click two opposite corners." : drawMode === "point" ? "Click the location to monitor." : "Click along the corridor; double-click to finish."}
              <button className="ml-2 underline" onClick={() => setDrawMode(null)}>Cancel</button>
            </div>
          ) : null}
          {edit ? (
            <div className="flex items-center gap-2 rounded-[3px] border border-signal/40 bg-ink-950/95 px-3 py-2 text-[0.75rem]">
              Drag vertices to edit “{edit.aoi.name}”.
              <Button size="sm" variant="primary" onClick={saveEdit}>Save boundary</Button>
              <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
            </div>
          ) : null}
        </div>
        {notice ? (
          <div className="absolute left-1/2 top-3 z-20 w-[min(560px,90%)] -translate-x-1/2">
            <Notice tone="info" className="bg-ink-950/95">
              <span className="flex items-start justify-between gap-3">{notice}<button aria-label="Dismiss" onClick={() => setNotice(null)}><X className="size-3.5" /></button></span>
            </Notice>
          </div>
        ) : null}
        {basemap.kind === "raster" && basemap.historical && !primaryRaster && !compare ? (
          <div className="pointer-events-none absolute left-3 top-14 z-10 max-w-[min(420px,calc(100%-24px))] rounded-[3px] border border-bone-50/[0.1] bg-ink-950/90 px-2 py-1 text-[0.6875rem] text-bone-50/70" role="note">
            Basemap: {basemap.label} — a mosaic of varying dates, not current conditions. Select a date to show satellite imagery with its acquisition date.
          </div>
        ) : null}
        {beyondResolution ? (
          <div className="absolute bottom-24 left-1/2 z-10 -translate-x-1/2 rounded-[3px] border border-data-amber/40 bg-ink-950/90 px-3 py-1.5 text-[0.75rem] text-data-amber" role="status">
            Zoomed past the image&apos;s native {gsd} m resolution (~{mpp?.toFixed(1)} m per screen pixel). Pixels are enlarged; no finer detail exists.
          </div>
        ) : null}

        {/* Active imagery strip */}
        {active || timelineObs.length || changeMap ? (
          <div className="absolute inset-x-3 bottom-3 z-10 rounded-[4px] border border-bone-50/[0.1] bg-ink-950/92 p-3 backdrop-blur lg:right-auto lg:max-w-[min(760px,calc(100%-420px))]">
            {changeMap ? (
              <div className="mb-2 flex flex-wrap items-center gap-3 border-b border-bone-50/[0.08] pb-2 text-[0.75rem]">
                <span className="font-medium">ΔNDVI change map · {changeMap.label}</span>
                <span className="text-bone-50/50">after − before, on pixels clear in both images</span>
                <label className="flex items-center gap-1.5 text-bone-50/60">Opacity<input type="range" min={0.1} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} /></label>
                <button className="text-bone-50/50 hover:text-bone-50" onClick={() => setChangeMap(null)}>Hide change map</button>
                <div className="w-full max-w-md"><RasterLegend legend={changeMap.legend} /></div>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-3 text-[0.75rem]">
              {active ? (
                <>
                  <span className="font-medium">{active.kind.toUpperCase().replace("_", " ")} · {formatDate(active.observedAt, timeZone)}</span>
                  <span className="text-bone-50/50">acquired {relativeTime(active.observedAt)} · {active.asset.platform ?? active.asset.collection} · {gsd} m</span>
                  {active.hasTrueColor ? (
                    <span className="flex overflow-hidden rounded-[3px] border border-bone-50/15">
                      {(["index", "true_color"] as const).map((l) => (
                        <button key={l} onClick={() => setLayer(l)} className={cn("px-2 py-0.5", layer === l ? "bg-bone-50 text-ink-900" : "text-bone-50/70")}>{l === "index" ? "Index" : "True color"}</button>
                      ))}
                    </span>
                  ) : null}
                  <label className="flex items-center gap-1.5 text-bone-50/60">Opacity<input type="range" min={0.1} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} /></label>
                  {timeline.filter((o) => o.asset.id === active.asset.id && o.hasRaster && o.status === "valid" && o.id !== active.id).map((o) => (
                    <button key={o.id} onClick={() => showObservation(o)} className="rounded-[3px] border border-bone-50/15 px-2 py-0.5 text-bone-50/70 hover:border-bone-50/40">
                      Show {o.kind.toUpperCase().replace("_", " ")}
                    </button>
                  ))}
                  <select
                    aria-label="Compare with another date"
                    className="rounded-[3px] border border-bone-50/15 bg-ink-950 px-2 py-0.5 text-[0.75rem] text-bone-50"
                    value={compare?.id ?? ""}
                    onChange={(e) => {
                      setChangeMap(null);
                      setCompare(timelineObs.find((o) => o.id === e.target.value) ?? null);
                    }}
                  >
                    <option value="">Compare with…</option>
                    {timelineObs.filter((o) => o.id !== active.id && o.status === "valid").map((o) => <option key={o.id} value={o.id}>{formatDate(o.observedAt, timeZone)}</option>)}
                  </select>
                  <button className="text-bone-50/50 hover:text-bone-50" onClick={() => showObservation(null)}>Hide imagery</button>
                </>
              ) : (
                <span className="text-bone-50/55">Select a date to display imagery for this area.</span>
              )}
            </div>
            {active?.legend && layer === "index" && !changeMap ? (
              <div className="mt-2 max-w-md"><RasterLegend legend={active.legend} /></div>
            ) : null}
            {timelineObs.length ? (
              <div className="mt-2 flex items-end gap-1 overflow-x-auto pb-1" role="listbox" aria-label="Observation dates">
                {timelineObs.map((o) => (
                  <button
                    key={o.id}
                    role="option"
                    aria-selected={active?.id === o.id}
                    title={`${formatDate(o.observedAt, timeZone)}${o.status === "unusable" ? " — unusable" : ""}`}
                    onClick={() => o.status === "valid" && (setChangeMap(null), setActive(o))}
                    disabled={o.status !== "valid"}
                    className={cn(
                      "t-mono shrink-0 rounded-[2px] border px-1.5 py-0.5 text-[0.625rem]",
                      active?.id === o.id ? "border-signal text-signal" : compare?.id === o.id ? "border-data-water text-data-water" : "border-bone-50/15 text-bone-50/65 hover:border-bone-50/40",
                      o.status !== "valid" && "border-dashed opacity-40",
                    )}
                  >
                    {formatDate(o.observedAt, timeZone).replace(/, \d{4}$/, "")}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Right inspector */}
        {draft || selDet || selEvent || selAoi || active ? (
          <aside className="absolute inset-y-0 right-0 z-20 w-[380px] max-w-full overflow-y-auto border-l border-bone-50/[0.08] bg-ink-950/96 backdrop-blur" aria-label="Details">
            {draft ? (
              <NewAoiPanel
                slug={slug}
                geometry={draft}
                defaultKind={props.orgKind === "agriculture" ? "field" : "region"}
                parents={parents}
                onCancel={() => {
                  setDraft(null);
                  setDrawMode(null);
                }}
                onCreated={async (aoi) => {
                  setDraft(null);
                  setDrawMode(null);
                  await refreshAois();
                  setSelAoi(aoi.id);
                  setNotice(`“${aoi.name}” saved. ORYN is searching imagery from the last 180 days; results appear as processing completes.`);
                }}
              />
            ) : selDet ? (
              <DetectionInspector
                key={selDet}
                slug={slug}
                detectionId={selDet}
                perms={perms}
                timeZone={timeZone}
                onClose={() => setSelDet(null)}
                onReviewed={refreshDetections}
                onFocus={(d: Detection) => mapRef.current?.fitBounds(d.bbox, { maxZoom: 16, padding: 120 })}
                onShowObservation={showObservation}
                onCompare={(before, after) => {
                  setChangeMap(null);
                  setActive(after);
                  setCompare(before);
                  setSwipe(50);
                }}
                onShowChangeMap={(d: Detection) => {
                  if (!d.changeMap) return;
                  setCompare(null);
                  setActive(d.comparison);
                  setChangeMap({
                    detectionId: d.id,
                    url: `${orgApi(slug)}/detections/${d.id}/change-raster`,
                    corners: d.changeMap.corners,
                    legend: d.changeMap.legend,
                    label: d.baseline && d.comparison ? `${formatDate(d.baseline.observedAt, timeZone)} → ${formatDate(d.comparison.observedAt, timeZone)}` : "",
                  });
                }}
              />
            ) : selEvent ? (
              <EventInspector
                key={selEvent.props.id}
                slug={slug}
                timeZone={timeZone}
                event={selEvent}
                aois={aois}
                canNote={perms.notes}
                onClose={() => setSelEvent(null)}
                onZoom={(b) => mapRef.current?.fitBounds(b, { maxZoom: 11, padding: 80 })}
                onSelectAoi={(id) => selectAoi(id)}
              />
            ) : selAoi ? (
              <AoiInspector
                key={selAoi}
                slug={slug}
                aoiId={selAoi}
                perms={perms}
                timeZone={timeZone}
                detections={detections}
                activeObservationId={active?.id ?? null}
                onLoaded={(a, obs) => {
                  setTimeline(obs);
                  setTimelineAoi(a.id);
                  const want = pendingImagery.current;
                  if (want && want.aoiId === a.id) {
                    pendingImagery.current = null;
                    resolveImagery(want, obs);
                  }
                }}
                chartKind={chartIndex}
                onChartKindChange={setChartIndex}
                onShowObservation={showObservation}
                onSelectDetection={selectDetection}
                onEditBoundary={(aoi) => {
                  const g = aoi.geometry;
                  if (g.type === "MultiPolygon" && g.coordinates.length === 1) {
                    setDrawMode(null);
                    setEdit({ aoi, geom: { type: "Polygon", coordinates: g.coordinates[0]! } });
                  }
                }}
                onChanged={refreshAois}
                onClose={() => {
                  setSelAoi(null);
                  showObservation(null);
                }}
              />
            ) : null}
            {active && !draft ? (
              <div className="border-t border-bone-50/[0.08] p-4">
                <p className="t-eyebrow mb-2 text-bone-50/45">Displayed imagery</p>
                <ObservationMeta o={active} timeZone={timeZone} layer={layer} />
              </div>
            ) : null}
          </aside>
        ) : null}

        {!selAoi && !selDet && !draft && aois.features.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="pointer-events-auto max-w-sm rounded-[4px] border border-bone-50/[0.1] bg-ink-950/92 p-5 text-center">
              <Circle className="mx-auto size-5 text-signal" aria-hidden="true" />
              <p className="mt-2 font-medium">No areas of interest yet</p>
              <p className="mt-1 text-[0.8125rem] text-bone-50/60">
                {perms.write ? "Search for a place, then draw a polygon, rectangle, point, or corridor to start monitoring." : "An analyst or administrator needs to add areas before results appear."}
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
