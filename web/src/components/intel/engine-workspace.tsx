"use client";

/**
 * The Intelligence globe, powered by the God's Eye View geospatial engine.
 *
 * The engine (the root of ORYN-PLATFORM) runs in its own same-origin document
 * under /engine/: it needs a different Content-Security-Policy than the
 * platform (Cesium's widgets require 'unsafe-eval'), and its global styles and
 * single-page lifecycle stay isolated from the ORYN shell. Everything around
 * the globe is native ORYN UI, and every engine action goes through the
 * engine's typed host bridge (`__gevHost`, see src/lib/intel/engine.ts):
 * layers and their status come from the engine's own lifecycle, never from
 * copies here. ORYN's areas and findings come from the permission-checked
 * /api/v1/orgs/[org] endpoints and are drawn on the engine's globe.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Layers, LocateFixed, Map as MapIcon, Search, X } from "lucide-react";
import { AoiCard, DetectionCard } from "@/components/intel/intel-cards";
import { api, ApiError, orgApi } from "@/components/map/api";
import type { AoiFeatureProps, DetectionFeatureProps, FC } from "@/components/map/types";
import { Badge, Button, Notice } from "@/components/platform/ui";
import { cn } from "@/lib/cn";
import { formatDateTime, relativeTime } from "@/lib/format";
import { parseCoordinates } from "@/lib/geo";
import {
  ENGINE_DOCUMENT,
  zoomForHeight,
  type EngineBridge,
  type EngineFeedState,
  type EngineLayer,
  type EngineRef,
} from "@/lib/intel/engine";

export type EngineWorkspaceProps = {
  slug: string;
  timeZone: string;
  canNote: boolean;
  initialAois: FC<AoiFeatureProps>;
  initialBounds: [number, number, number, number] | null;
  focus: { at?: { lon: number; lat: number; heightM: number } };
};

type BadgeTone = "good" | "info" | "watch" | "alert" | "muted";
const STATE_TONE: Record<EngineFeedState, BadgeTone | null> = {
  current: "good",
  fallback: "info",
  loading: "muted",
  partial: "info",
  stale: "watch",
  unavailable: "alert",
  off: null,
};
const STATE_LABEL: Record<EngineFeedState, string> = {
  current: "Current",
  fallback: "Fallback",
  loading: "Loading",
  partial: "Partial",
  stale: "Stale",
  unavailable: "Unavailable",
  off: "Off",
};

/** Engine layers grouped the way the intel panel groups its layers. */
const ENGINE_GROUPS: { label: string; ids: string[] }[] = [
  { label: "Public events", ids: ["earthquakes", "local-firms", "fire-perimeters", "weather-cyclones", "rocket-launches", "gnss-integrity"] },
  { label: "Movement", ids: ["flights", "military", "military-awareness", "ais-live-vessels", "transit", "bikeshare", "traffic"] },
  { label: "Orbits", ids: ["satellites"] },
  { label: "Cameras", ids: ["cctv", "alpr-cameras", "street-level"] },
  { label: "Weather", ids: ["weather-radar", "weather-satellite", "weather-lightning", "wind", "air-quality"] },
  { label: "Imagery", ids: ["recent-imagery"] },
  { label: "Infrastructure", ids: ["military-installations", "local-datacenters", "local-dams", "telegeography-submarine-cables"] },
  { label: "Utilities", ids: ["directions", "radio", "local-adsb"] },
];
const GROUPED = new Set(ENGINE_GROUPS.flatMap((g) => g.ids));

/**
 * Modes keep the intel page's names. Each turns on engine layers and ORYN data
 * and turns off the other layers a mode manages; the descriptions say what the
 * engine actually shows.
 */
type EngineMode = { id: string; label: string; description: string; engine: string[]; aois: boolean; detections: boolean };
const MODES: EngineMode[] = [
  { id: "global", label: "Global intelligence", description: "Public hazard events worldwide and the satellites over them.", engine: ["earthquakes", "fire-perimeters", "weather-cyclones", "satellites"], aois: false, detections: false },
  { id: "agriculture", label: "Agriculture and environment", description: "Your fields and findings with wildfire, active-fire, and satellite cloud context.", engine: ["fire-perimeters", "local-firms", "weather-satellite"], aois: true, detections: true },
  { id: "municipal", label: "Municipal and infrastructure", description: "Your areas and findings with seismic and wildfire context and mapped infrastructure.", engine: ["earthquakes", "fire-perimeters", "local-dams", "local-datacenters"], aois: true, detections: true },
  { id: "traffic", label: "Traffic and cameras", description: "Public camera locations and frames where operators publish them, transit, and road traffic simulated on real roads.", engine: ["cctv", "transit", "traffic"], aois: false, detections: false },
  { id: "incident", label: "Incident investigation", description: "Your areas and findings with public hazard events and replayable weather radar.", engine: ["earthquakes", "fire-perimeters", "local-firms", "weather-radar"], aois: true, detections: true },
];
const MODE_MANAGED = new Set(MODES.flatMap((m) => m.engine));

const KIND_LABEL: Record<string, string> = {
  aircraft: "Aircraft",
  vessel: "Vessel",
  satellite: "Satellite",
  camera: "Camera",
  earthquake: "Earthquake",
  "fire-detection": "Active fire",
  "fire-perimeter": "Wildfire perimeter",
  cyclone: "Tropical cyclone",
  installation: "Installation",
  infrastructure: "Infrastructure",
  entity: "Feature",
};

const ENGINE_READY_TIMEOUT_MS = 120_000;

type Selection = { kind: "aoi"; id: string } | { kind: "detection"; id: string } | { kind: "engine"; ref: EngineRef };
type Hit = { label: string; sub: string; run: () => void };

function fieldLabel(key: string) {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export function EngineWorkspace(props: EngineWorkspaceProps) {
  const { slug, timeZone } = props;
  const frame = useRef<HTMLIFrameElement>(null);
  const [bridge, setBridge] = useState<EngineBridge | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [layers, setLayers] = useState<EngineLayer[]>([]);
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [mode, setMode] = useState<string | null>(null);
  const [showAois, setShowAois] = useState(true);
  const [showDetections, setShowDetections] = useState(true);
  const [detections, setDetections] = useState<{ fc: FC<DetectionFeatureProps> | null; error: string | null; retrievedAt: string | null } | null>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const [query, setQuery] = useState("");
  const [leftOpen, setLeftOpen] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [view2d, setView2d] = useState<string | null>(null);

  // 1. Check the engine service is reachable, then wait for its bridge.
  useEffect(() => {
    let cancelled = false;
    fetch(ENGINE_DOCUMENT, { credentials: "same-origin", cache: "no-store" })
      .then((res) => {
        if (cancelled || res.ok) return;
        setFatal(
          res.status === 401
            ? "Your session has expired. Sign in again to use the globe."
            : "The geospatial engine is not running on this deployment. Start it with npm run oryn:engine (see ORYN_INTEGRATION_PLAN.md).",
        );
      })
      .catch(() => !cancelled && setFatal("The geospatial engine could not be reached."));
    const deadline = window.setTimeout(() => {
      if (!cancelled) setFatal((f) => f ?? "The geospatial engine did not finish starting. Reload the page to try again.");
    }, ENGINE_READY_TIMEOUT_MS);
    const poll = window.setInterval(() => {
      const host = frame.current?.contentWindow as (Window & { __gevHost?: EngineBridge }) | null | undefined;
      const b = host?.__gevHost;
      if (!b) return;
      const st = b.status();
      if (st.state === "ready") {
        window.clearInterval(poll);
        window.clearTimeout(deadline);
        if (!cancelled) setBridge(b);
      } else if (st.state === "failed") {
        window.clearInterval(poll);
        window.clearTimeout(deadline);
        if (!cancelled) setFatal(st.error ?? "The geospatial engine failed to start.");
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
      window.clearTimeout(deadline);
    };
  }, []);

  // 2. Once ready: starting view, ORYN layer panel, live layer status, selection.
  useEffect(() => {
    if (!bridge) return;
    bridge.setExternalLayerPanel(true);
    const at = props.focus.at;
    if (at) bridge.setView({ lat: at.lat, lon: at.lon, height: at.heightM });
    else if (props.initialBounds) {
      const b = props.initialBounds;
      bridge.setView({ lat: (b[1] + b[3]) / 2, lon: (b[0] + b[2]) / 2, height: 2_500_000 });
    } else bridge.setView({ lat: 32, lon: -95, height: 20_000_000 });
    const refresh = () => setLayers(bridge.listLayers());
    refresh();
    const camera = () => {
      const c = bridge.getCamera();
      if (c) setView2d(`${c.lon.toFixed(4)},${c.lat.toFixed(4)},${zoomForHeight(c.alt).toFixed(1)}`);
    };
    camera();
    const cameraTimer = window.setInterval(camera, 2_000);
    const off = bridge.subscribe((event) => {
      if (event.type === "layers") refresh();
      else if (event.type === "selection") {
        const ref = event.ref;
        if (!ref) return;
        if (ref.layerId === "host:aois") setSel({ kind: "aoi", id: ref.id });
        else if (ref.layerId === "host:detections") setSel({ kind: "detection", id: ref.id });
        else setSel({ kind: "engine", ref });
      } else if (event.type === "status" && event.status.state === "failed") setFatal(event.status.error ?? "The geospatial engine stopped.");
    });
    return () => {
      off();
      window.clearInterval(cameraTimer);
    };
  }, [bridge, props.focus.at, props.initialBounds]);

  // 3. ORYN data on the engine's globe: areas (server-rendered) and findings (API).
  useEffect(() => {
    if (!bridge) return;
    bridge
      .setOverlay("aois", props.initialAois, { kind: "aoi", source: "ORYN", stroke: "#f2f1ed", fill: "rgba(242,241,237,0.06)", strokeWidth: 2 })
      .catch(() => setNotice("Your areas could not be drawn on the globe."));
  }, [bridge, props.initialAois]);
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    api<FC<DetectionFeatureProps>>(`${orgApi(slug)}/detections?verification=unverified,needs_field_check,confirmed&minGrade=moderate&withinDays=365`)
      .then(async (fc) => {
        if (cancelled) return;
        setDetections({ fc, error: null, retrievedAt: new Date().toISOString() });
        await bridge.setOverlay("detections", fc, { kind: "detection", source: "ORYN", stroke: "#e9b949", fill: "rgba(233,185,73,0.14)", strokeWidth: 2 });
      })
      .catch((e: unknown) => {
        if (!cancelled) setDetections({ fc: null, error: e instanceof ApiError ? e.message : "Findings could not be loaded.", retrievedAt: null });
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, slug]);
  useEffect(() => {
    bridge?.setOverlayVisible("aois", showAois);
  }, [bridge, showAois]);
  useEffect(() => {
    bridge?.setOverlayVisible("detections", showDetections);
  }, [bridge, showDetections]);

  const toggleLayer = useCallback(
    async (id: string, enabled: boolean) => {
      if (!bridge) return;
      setPending((s) => new Set(s).add(id));
      try {
        await bridge.setLayerEnabled(id, enabled);
      } catch {
        setNotice("That layer could not be changed. Try again.");
      } finally {
        setPending((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        });
        setLayers(bridge.listLayers());
      }
    },
    [bridge],
  );

  async function applyMode(m: EngineMode) {
    if (!bridge) return;
    setMode(m.id);
    setShowAois(m.aois);
    setShowDetections(m.detections);
    const want = new Set(m.engine);
    const unavailable: string[] = [];
    await Promise.all(
      bridge.listLayers().map(async (l) => {
        if (!MODE_MANAGED.has(l.id)) return;
        const on = want.has(l.id);
        if (on === l.enabled) return;
        if (on && l.state === "unavailable") {
          unavailable.push(l.name);
          return;
        }
        await toggleLayer(l.id, on);
      }),
    );
    if (unavailable.length) setNotice(`Not available on this deployment: ${unavailable.join(", ")}.`);
  }

  const hits = useMemo<Hit[]>(() => {
    const q = query.trim();
    if (q.length < 2) return [];
    const out: Hit[] = [];
    const coords = parseCoordinates(q);
    if (coords && bridge) out.push({ label: `${coords[1].toFixed(4)}, ${coords[0].toFixed(4)}`, sub: "Coordinates", run: () => bridge.flyTo({ lat: coords[1], lon: coords[0], range: 20_000 }) });
    const needle = q.toLowerCase();
    for (const f of props.initialAois.features) {
      if (out.length >= 8) break;
      if (f.properties.name.toLowerCase().includes(needle)) out.push({ label: f.properties.name, sub: "Area of interest", run: () => select({ kind: "aoi", id: f.properties.id }) });
    }
    for (const f of detections?.fc?.features ?? []) {
      if (out.length >= 10) break;
      if (f.properties.title.toLowerCase().includes(needle)) out.push({ label: f.properties.title, sub: `Finding · ${f.properties.aoi_name}`, run: () => select({ kind: "detection", id: f.properties.id }) });
    }
    if (bridge) {
      for (const ref of bridge.searchEntities(q, { limit: 8 })) {
        out.push({
          label: ref.label,
          sub: `${KIND_LABEL[ref.kind] ?? "Feature"}${ref.source ? ` · ${ref.source}` : ""}`,
          run: () => {
            setSel({ kind: "engine", ref });
            if (ref.position) bridge.flyTo({ lat: ref.position.lat, lon: ref.position.lon, range: 25_000 });
          },
        });
      }
      if (!coords)
        out.push({
          label: `Find "${q}"`,
          sub: "Place search",
          run: () => {
            bridge
              .search(q)
              .then((r) => !r.found && setNotice(`No place found for "${q}".`))
              .catch(() => setNotice("Place search is unavailable right now."));
          },
        });
    }
    return out;
    // select is stable for this purpose; it only reads the current bridge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, bridge, props.initialAois, detections]);

  function select(s: Selection) {
    setSel(s);
    if (!bridge) return;
    if (s.kind === "aoi") {
      const f = props.initialAois.features.find((x) => x.properties.id === s.id);
      const c = f ? centerOf(f.geometry) : null;
      if (c) bridge.flyTo({ lat: c[1], lon: c[0], range: 6_000, pitch: -50 });
    } else if (s.kind === "detection") {
      const f = detections?.fc?.features.find((x) => x.properties.id === s.id);
      const c = f ? centerOf(f.geometry) : null;
      if (c) bridge.flyTo({ lat: c[1], lon: c[0], range: 3_000, pitch: -50 });
    }
  }

  const byId = new Map(layers.filter((l) => l.showInTogglePanel).map((l) => [l.id, l]));
  const groups = [
    ...ENGINE_GROUPS.map((g) => ({ label: g.label, items: g.ids.map((id) => byId.get(id)).filter((l): l is EngineLayer => Boolean(l)) })),
    { label: "Other", items: [...byId.values()].filter((l) => !GROUPED.has(l.id) && !l.id.startsWith("bhote-koshi")) },
  ].filter((g) => g.items.length);
  const selArea = sel?.kind === "aoi" ? props.initialAois.features.find((f) => f.properties.id === sel.id)?.properties : undefined;
  const selDetection = sel?.kind === "detection" ? detections?.fc?.features.find((f) => f.properties.id === sel.id)?.properties : undefined;
  const aoiCount = props.initialAois.features.length;

  return (
    <div className="relative flex h-full min-h-0">
      {/* Left panel: search, modes, layers */}
      <aside className={cn("absolute inset-y-0 left-0 z-20 flex w-[310px] max-w-[85vw] flex-col border-r border-bone-50/[0.08] bg-ink-950/95 backdrop-blur transition-transform lg:static lg:translate-x-0", leftOpen ? "translate-x-0" : "-translate-x-full lg:hidden")}>
        <div className="flex items-center gap-2 border-b border-bone-50/[0.08] p-3" role="search">
          <Search className="size-4 shrink-0 text-bone-50/45" aria-hidden="true" />
          <input aria-label="Search areas, findings, loaded globe records, places, or coordinates" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the globe or enter lat, lon" className="min-w-0 flex-1 bg-transparent text-[0.8125rem] placeholder:text-bone-50/30 focus:outline-none" />
          {query ? <button aria-label="Clear search" onClick={() => setQuery("")}><X className="size-3.5 text-bone-50/50" /></button> : null}
        </div>
        {hits.length ? (
          <ul className="border-b border-bone-50/[0.08] p-2" aria-label="Search results">
            {hits.map((h, i) => (
              <li key={i}>
                <button
                  className="block w-full rounded-[2px] px-2 py-1.5 text-left text-[0.75rem] hover:bg-bone-50/[0.05]"
                  onClick={() => {
                    h.run();
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
              {MODES.map((m) => (
                <button key={m.id} disabled={!bridge} onClick={() => void applyMode(m)} aria-pressed={mode === m.id} className={cn("rounded-[3px] border px-2 py-1.5 text-left disabled:opacity-45", mode === m.id ? "border-signal/60 bg-signal/[0.06]" : "border-bone-50/10 hover:border-bone-50/30")}>
                  <span className="block text-[0.8125rem]">{m.label}</span>
                  <span className="block text-[0.6875rem] text-bone-50/45">{m.description}</span>
                </button>
              ))}
            </div>
          </section>

          <fieldset className="mb-4 min-w-0">
            <legend className="t-eyebrow mb-2 text-bone-50/45">ORYN data</legend>
            <div className="py-1">
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" disabled={!bridge} checked={showAois} onChange={(e) => { setMode(null); setShowAois(e.target.checked); }} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span>Areas of interest</span>
                    {showAois && bridge ? <Badge tone="good">Current</Badge> : null}
                  </span>
                  <span className="block text-[0.6875rem] text-bone-50/45">organization data · Your organization&apos;s monitored fields and areas.</span>
                  <span className="block text-[0.6875rem] text-bone-50/55">{aoiCount} shown</span>
                </span>
              </label>
            </div>
            <div className="py-1">
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" disabled={!bridge} checked={showDetections} onChange={(e) => { setMode(null); setShowDetections(e.target.checked); }} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span>Candidate changes and zones</span>
                    {showDetections && detections ? <Badge tone={detections.error ? "alert" : "good"}>{detections.error ? "Unavailable" : "Current"}</Badge> : null}
                  </span>
                  <span className="block text-[0.6875rem] text-bone-50/45">derived analytics · ORYN findings from the last year at moderate evidence or stronger; review them in the map workspace.</span>
                  {detections?.fc ? (
                    <span className="block text-[0.6875rem] text-bone-50/55">
                      {detections.fc.features.length} shown{detections.retrievedAt ? ` · retrieved ${relativeTime(detections.retrievedAt)}` : ""}
                    </span>
                  ) : null}
                  {detections?.error ? <span className="block text-[0.6875rem] text-data-amber">{detections.error}</span> : null}
                </span>
              </label>
            </div>
          </fieldset>

          {!bridge && !fatal ? <p className="mb-4 text-[0.75rem] text-bone-50/55" role="status">Loading the globe&apos;s layers…</p> : null}
          {groups.map((g) => (
            <fieldset key={g.label} className="mb-4 min-w-0">
              <legend className="t-eyebrow mb-2 text-bone-50/45">{g.label}</legend>
              {g.items.map((l) => (
                <LayerRow key={l.id} layer={l} busy={pending.has(l.id)} bridge={bridge} onToggle={(on) => { setMode(null); void toggleLayer(l.id, on); }} />
              ))}
            </fieldset>
          ))}
          <p className="text-[0.6875rem] text-bone-50/40">
            Geospatial engine: God&apos;s Eye View (MIT). Public feeds refresh periodically; each layer shows its source and when it was last retrieved. Layers marked Unavailable need a provider key or are not reachable from this deployment.
          </p>
        </div>
      </aside>

      {/* Globe */}
      <div className="relative min-w-0 flex-1 bg-ink-950">
        <iframe
          ref={frame}
          src={ENGINE_DOCUMENT}
          title="Intelligence globe"
          className={cn("absolute inset-0 h-full w-full border-0", bridge ? "opacity-100" : "opacity-0")}
        />
        {fatal ? (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <div className="max-w-sm rounded-[4px] border border-bone-50/[0.1] bg-ink-950/95 p-5 text-center text-[0.8125rem]">
              <p className="font-medium">3D view unavailable</p>
              <p className="mt-1 text-bone-50/60">{fatal}</p>
              <Link className="mt-3 inline-block underline" href={`/app/${slug}/map`}>Open the 2D map workspace</Link>
            </div>
          </div>
        ) : !bridge ? (
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

        {/* Right inspector */}
        {sel ? (
          <aside className="absolute inset-y-0 right-0 z-20 w-[380px] max-w-full overflow-y-auto border-l border-bone-50/[0.08] bg-ink-950/96 backdrop-blur" aria-label="Details">
            {sel.kind === "aoi" && selArea ? (
              <AoiCard slug={slug} timeZone={timeZone} aoi={selArea} onClose={() => setSel(null)} onSelectSatellite={() => { if (bridge) void toggleLayer("satellites", true); }} />
            ) : sel.kind === "detection" && selDetection ? (
              <DetectionCard slug={slug} timeZone={timeZone} d={selDetection} onClose={() => setSel(null)} />
            ) : sel.kind === "engine" ? (
              <EngineCard r={sel.ref} timeZone={timeZone} bridge={bridge} onClose={() => setSel(null)} />
            ) : (
              <p className="p-4 text-[0.75rem] text-bone-50/50">This item is no longer in the loaded data. <button className="underline" onClick={() => setSel(null)}>Close</button></p>
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function LayerRow({ layer: l, busy, bridge, onToggle }: { layer: EngineLayer; busy: boolean; bridge: EngineBridge | null; onToggle: (on: boolean) => void }) {
  const tone = l.enabled ? STATE_TONE[l.state] : null;
  const blocked = !l.enabled && l.state === "unavailable";
  return (
    <div className="py-1">
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" disabled={!bridge || busy || blocked} checked={l.enabled} onChange={(e) => onToggle(e.target.checked)} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span>{l.name}</span>
            {tone ? <Badge tone={tone}>{STATE_LABEL[l.state]}</Badge> : blocked ? <Badge tone="muted">Unavailable</Badge> : null}
          </span>
          {l.source ? <span className="block text-[0.6875rem] text-bone-50/45">{l.source}</span> : null}
          {l.enabled && (l.count > 0 || l.lastUpdate) ? (
            <span className="block text-[0.6875rem] text-bone-50/55">
              {l.count} shown{l.lastUpdate ? ` · retrieved ${relativeTime(l.lastUpdate)}` : ""}
            </span>
          ) : null}
          {(l.enabled || blocked) && l.error ? <span className="block text-[0.6875rem] text-data-amber">{l.error}</span> : null}
          {blocked && l.requiresKeyId && !l.error ? <span className="block text-[0.6875rem] text-data-amber">Needs a provider key configured on the engine server.</span> : null}
        </span>
      </label>
      {l.enabled && l.controls ? (
        <div className="ml-6 mt-1 flex flex-col gap-1">
          {l.controls.chips.length ? (
            <div className="flex flex-wrap gap-1">
              {l.controls.chips.map((c) => (
                <button
                  key={c.id}
                  disabled={c.disabled || !bridge}
                  title={c.title ?? undefined}
                  aria-pressed={c.active}
                  onClick={() => bridge?.applyRowControl(l.id, c.id)}
                  className={cn("rounded-[3px] border px-1.5 py-0.5 text-[0.6875rem] disabled:opacity-45", c.active ? "border-bone-50 bg-bone-50 text-ink-900" : "border-bone-50/20 text-bone-50/75 hover:border-bone-50/50")}
                >
                  {c.label}
                </button>
              ))}
            </div>
          ) : null}
          {l.controls.legend.length ? (
            <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-[0.6875rem] text-bone-50/55">
              {l.controls.legend.map((item, i) => (
                <li key={i} className="flex items-center gap-1">
                  {item.color ? <span className="inline-block size-2 rounded-full" style={{ background: item.color }} aria-hidden="true" /> : null}
                  {item.label}
                  {item.count !== null ? <span className="text-bone-50/40">{item.count}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {l.controls.items.length ? (
            <ol className="flex flex-col gap-0.5 text-[0.6875rem]">
              {l.controls.items.slice(0, 12).map((item) => (
                <li key={item.id}>
                  <button className={cn("block w-full truncate rounded-[2px] px-1 py-0.5 text-left hover:bg-bone-50/[0.05]", item.active ? "text-signal" : "text-bone-50/75")} onClick={() => bridge?.applyListItem(l.id, item.id)}>
                    {item.label}
                    {item.detail ? <span className="text-bone-50/40"> · {item.detail}</span> : null}
                  </button>
                </li>
              ))}
            </ol>
          ) : null}
          {l.controls.info ? <p className="text-[0.6875rem] text-bone-50/45">{l.controls.info}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/** A globe record from a public feed: what it is, where it came from, and when. */
function EngineCard({ r, timeZone, bridge, onClose }: { r: EngineRef; timeZone: string; bridge: EngineBridge | null; onClose: () => void }) {
  const fields = Object.entries(r.fields);
  return (
    <div className="flex flex-col gap-3 p-4 text-[0.8125rem]" aria-label="Globe record details">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="t-eyebrow text-bone-50/45">{KIND_LABEL[r.kind] ?? "Feature"}{r.source ? ` · ${r.source}` : ""}</p>
          <h2 className="mt-1 text-[0.9375rem] font-medium">{r.label || r.id}</h2>
        </div>
        <button aria-label="Close" onClick={onClose} className="p-1 text-bone-50/50 hover:text-bone-50"><X className="size-4" /></button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Badge tone="info">Provider-reported</Badge>
        <Badge tone="muted">Public feed</Badge>
      </div>
      <dl>
        <Row k="Coordinates" v={r.position ? `${r.position.lat.toFixed(5)}, ${r.position.lon.toFixed(5)}` : null} />
        <Row k="Altitude" v={r.position?.height !== undefined ? `${Math.round(r.position.height)} m` : null} />
        <Row k="Observed" v={r.observedAt ? `${formatDateTime(r.observedAt, timeZone)} (${relativeTime(r.observedAt)})` : null} />
        <Row k="Retrieved by ORYN" v={r.retrievedAt ? `${formatDateTime(r.retrievedAt, timeZone)} (${relativeTime(r.retrievedAt)})` : null} />
        {fields.map(([k, v]) => (
          <Row key={k} k={fieldLabel(k)} v={String(v)} />
        ))}
      </dl>
      <p className="text-[0.75rem] text-bone-50/50">Values are shown as the provider reported them. Public feeds refresh periodically and do not cover every location.</p>
      <div className="flex flex-wrap gap-2">
        {r.position && bridge ? (
          <Button size="sm" onClick={() => r.position && bridge.flyTo({ lat: r.position.lat, lon: r.position.lon, range: r.kind === "satellite" ? 4_000_000 : 20_000 })}>
            <LocateFixed className="size-3.5" aria-hidden="true" /> Focus
          </Button>
        ) : null}
        {r.sourceUrl ? (
          <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex h-7 items-center gap-1.5 rounded-[3px] border border-bone-50/20 px-2.5 text-[0.8125rem] font-medium hover:border-bone-50/50">
            <ExternalLink className="size-3.5" aria-hidden="true" /> Source record
          </a>
        ) : null}
      </div>
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

/** Rough center of a GeoJSON geometry (bounding-box midpoint), for camera moves only. */
function centerOf(geometry: GeoJSON.Geometry): [number, number] | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number") {
      minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0]);
      minY = Math.min(minY, c[1]); maxY = Math.max(maxY, c[1]);
    } else if (Array.isArray(c)) c.forEach(visit);
  };
  if (geometry.type === "GeometryCollection") geometry.geometries.forEach((g) => { const c = centerOf(g); if (c) visit(c); });
  else visit(geometry.coordinates);
  return Number.isFinite(minX) ? [(minX + maxX) / 2, (minY + maxY) / 2] : null;
}
