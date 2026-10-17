"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { LogoMark } from "@/components/brand/logo";
import { MAP, fleet, missions, type Finding, type Mission } from "@/content/missions";
import { useElementSize } from "@/lib/use-element-size";
import { cn } from "@/lib/cn";

type Layer = "imagery" | "analysis" | "terrain";
type Panel = "findings" | "flight" | "processing";
type View = { cx: number; cy: number; z: number };

const LAYERS: { id: Layer; label: string }[] = [
  { id: "imagery", label: "Imagery" },
  { id: "analysis", label: "Analysis" },
  { id: "terrain", label: "Terrain" },
];

const severityColor: Record<Finding["severity"], string> = {
  attention: "var(--color-signal)",
  watch: "var(--color-data-amber)",
  info: "var(--color-steel-200)",
};
const severityLabel: Record<Finding["severity"], string> = {
  attention: "Attention",
  watch: "Watch",
  info: "Info",
};
const statusColor: Record<Mission["status"], string> = {
  Delivered: "var(--color-data-veg)",
  "In review": "var(--color-data-amber)",
  Processing: "var(--color-data-water)",
};

// ── Geo helpers (Web Mercator) ──────────────────────────────────
const toMerc = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const MERC_N = toMerc(MAP.bounds.north);
const MERC_S = toMerc(MAP.bounds.south);
function toLatLon(x: number, y: number) {
  const lon = MAP.bounds.west + (x / MAP.width) * (MAP.bounds.east - MAP.bounds.west);
  const m = MERC_N - (y / MAP.height) * (MERC_N - MERC_S);
  const lat = (2 * Math.atan(Math.exp(m)) - Math.PI / 2) * (180 / Math.PI);
  return { lat, lon };
}
function fmtCoord({ lat, lon }: { lat: number; lon: number }) {
  return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? "N" : "S"}  ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? "E" : "W"}`;
}

function surveyPath(m: Mission): [number, number][] {
  const { x0, y0, x1, y1, spacing, vertical } = m.path;
  const pts: [number, number][] = [];
  if (vertical) {
    let k = 0;
    for (let x = x0; x <= x1; x += spacing, k++) {
      if (k % 2 === 0) pts.push([x, y0], [x, y1]);
      else pts.push([x, y1], [x, y0]);
    }
  } else {
    let k = 0;
    for (let y = y0; y <= y1; y += spacing, k++) {
      if (k % 2 === 0) pts.push([x0, y], [x1, y]);
      else pts.push([x1, y], [x0, y]);
    }
  }
  return pts;
}

function pointAlong(pts: [number, number][], t: number): [number, number] {
  const segs: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segs.push(l);
    total += l;
  }
  let d = t * total;
  for (let i = 0; i < segs.length; i++) {
    const l = segs[i]!;
    if (d <= l) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const f = l === 0 ? 0 : d / l;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    d -= l;
  }
  return pts[pts.length - 1] ?? [0, 0];
}

export function CommandPreview() {
  const [missionId, setMissionId] = useState(missions[0]!.id);
  const [layer, setLayer] = useState<Layer>("imagery");
  const [panel, setPanel] = useState<Panel>("findings");
  const [rail, setRail] = useState<"missions" | "fleet">("missions");
  const [findingId, setFindingId] = useState<string | null>(null);
  const [category, setCategory] = useState<string>("All");
  const [view, setView] = useState<View>(() => {
    const v = missions[0]!.view;
    return { cx: v.x, cy: v.y, z: v.zoom };
  });
  const [dragging, setDragging] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [replay, setReplay] = useState<number | null>(null);
  const reduce = useReducedMotion();

  const mission = missions.find((m) => m.id === missionId)!;
  const finding = mission.findings.find((f) => f.id === findingId) ?? null;
  const categories = useMemo(() => ["All", ...Array.from(new Set(mission.findings.map((f) => f.category)))], [mission]);
  const visibleFindings = mission.findings.filter((f) => category === "All" || f.category === category);
  const path = useMemo(() => surveyPath(mission), [mission]);

  // ── Map geometry ─────────────────────────────────────────────
  const viewportRef = useRef<HTMLDivElement>(null);
  const { width: w, height: h } = useElementSize(viewportRef);
  const base = w && h ? Math.max(w / MAP.width, h / MAP.height) : 0.3;
  const clampView = useCallback(
    (v: View): View => {
      const z = Math.max(1, Math.min(8, v.z));
      const s = base * z;
      const hw = w / (2 * s);
      const hh = h / (2 * s);
      return {
        z,
        cx: Math.max(hw, Math.min(MAP.width - hw, v.cx)),
        cy: Math.max(hh, Math.min(MAP.height - hh, v.cy)),
      };
    },
    [base, w, h],
  );
  const cv = clampView(view);
  const s = base * cv.z;
  const tx = w / 2 - cv.cx * s;
  const ty = h / 2 - cv.cy * s;

  const selectMission = (m: Mission) => {
    setMissionId(m.id);
    setFindingId(null);
    setCategory("All");
    setReplay(null);
    setReplayRun(0);
    setView({ cx: m.view.x, cy: m.view.y, z: m.view.zoom });
  };
  const selectFinding = (f: Finding) => {
    setFindingId(f.id);
    setPanel("findings");
    setView((v) => ({ cx: f.x, cy: f.y, z: Math.max(v.z, mission.view.zoom * 1.5) }));
  };
  const zoomBy = (k: number) => setView((v) => ({ ...clampView(v), z: v.z * k }));
  const resetView = () => setView({ cx: mission.view.x, cy: mission.view.y, z: mission.view.zoom });

  // ── Pan ──────────────────────────────────────────────────────
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    drag.current = { x: e.clientX, y: e.clientY, cx: cv.cx, cy: cv.cy, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setCursor({ x: cv.cx + (e.clientX - r.left - w / 2) / s, y: cv.cy + (e.clientY - r.top - h / 2) / s });
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) > 3) {
      d.moved = true;
      setDragging(true);
    }
    if (d.moved) setView((v) => clampView({ ...v, cx: d.cx - dx / s, cy: d.cy - dy / s }));
  };
  const endDrag = () => {
    drag.current = null;
    setDragging(false);
  };

  // ── Flight replay ────────────────────────────────────────────
  const [replayRun, setReplayRun] = useState(0);
  useEffect(() => {
    if (replayRun === 0) return;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 9000);
      setReplay(t);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [replayRun]);
  const aircraftPos = replay !== null ? pointAlong(path, replay) : null;

  // ── Live UTC clock (client only) ─────────────────────────────
  const [clock, setClock] = useState<string>("");
  useEffect(() => {
    const fmt = () => new Date().toISOString().slice(11, 19);
    const id = window.setInterval(() => setClock(fmt()), 1000);
    const first = window.setTimeout(() => setClock(fmt()), 0);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(first);
    };
  }, []);

  // Scale bar
  const mPerPx = MAP.metersPerPixel / s;
  const barMeters = [50, 100, 200, 500, 1000, 2000, 5000].filter((m) => m / mPerPx <= 110).pop() ?? 50;
  const barPx = barMeters / mPerPx;

  const transition = dragging || reduce ? "none" : "transform 0.9s cubic-bezier(0.16,1,0.3,1)";

  return (
    <div className="overflow-hidden rounded-[6px] border border-bone-50/10 bg-ink-950 text-bone-50 shadow-[0_40px_120px_-40px_rgba(0,0,0,0.9)]">
      {/* Top bar */}
      <div className="flex h-11 items-center justify-between gap-4 border-b border-bone-50/[0.08] bg-ink-900 px-3 md:px-4">
        <div className="flex min-w-0 items-center gap-3">
          <LogoMark className="h-4 w-auto shrink-0 text-bone-50" aria-hidden="true" />
          <span className="truncate text-[0.8125rem] font-medium">ORYN Command</span>
          <span className="hidden text-bone-50/25 sm:inline">/</span>
          <span className="t-mono hidden truncate text-bone-50/50 sm:inline">Operations · Sample workspace</span>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="t-mono hidden text-bone-50/60 md:inline" suppressHydrationWarning>
            UTC {clock || "--:--:--"}
          </span>
          <span className="t-mono rounded-[2px] border border-signal/40 px-2 py-0.5 text-[0.625rem] uppercase tracking-[0.14em] text-signal">
            Interactive product preview · Sample data
          </span>
        </div>
      </div>

      {/* Mobile mission selector */}
      <div className="no-scrollbar flex gap-2 overflow-x-auto border-b border-bone-50/[0.08] p-2 lg:hidden" role="tablist" aria-label="Missions">
        {missions.map((m) => (
          <button
            key={m.id}
            role="tab"
            aria-selected={m.id === missionId}
            onClick={() => selectMission(m)}
            className={cn(
              "shrink-0 rounded-[3px] border px-3 py-2 text-left transition-colors",
              m.id === missionId ? "border-bone-50/30 bg-bone-50/[0.06]" : "border-bone-50/10",
            )}
          >
            <span className="t-mono block text-bone-50/60">{m.id}</span>
            <span className="block text-[0.8125rem]">{m.name}</span>
          </button>
        ))}
      </div>

      <div className="grid lg:h-[680px] lg:grid-cols-[264px_minmax(0,1fr)_316px]">
        {/* Left rail */}
        <div className="hidden min-h-0 flex-col border-r border-bone-50/[0.08] bg-ink-900/60 lg:flex">
          <div className="flex border-b border-bone-50/[0.08] p-1.5" role="tablist" aria-label="Sidebar">
            {(["missions", "fleet"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={rail === t}
                onClick={() => setRail(t)}
                className={cn(
                  "flex-1 rounded-[3px] py-1.5 text-[0.75rem] capitalize transition-colors",
                  rail === t ? "bg-bone-50/[0.08] text-bone-50" : "text-bone-50/50 hover:text-bone-50",
                )}
              >
                {t}
              </button>
            ))}
          </div>
          {rail === "missions" ? (
            <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {missions.map((m) => (
                <li key={m.id}>
                  <button
                    onClick={() => selectMission(m)}
                    aria-pressed={m.id === missionId}
                    className={cn(
                      "group w-full rounded-[3px] border px-3 py-3 text-left transition-colors",
                      m.id === missionId
                        ? "border-bone-50/15 bg-bone-50/[0.05]"
                        : "border-transparent hover:bg-bone-50/[0.03]",
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className="t-mono text-bone-50/60">{m.id}</span>
                      <span className="t-mono flex items-center gap-1.5 text-[0.625rem] uppercase tracking-[0.1em] text-bone-50/55">
                        <span className="size-1.5 rounded-full" style={{ background: statusColor[m.status] }} />
                        {m.status}
                      </span>
                    </div>
                    <div className="mt-1.5 text-[0.875rem] leading-snug">{m.name}</div>
                    <div className="t-mono mt-1 text-bone-50/55">
                      {m.type} · {m.findings.length} findings
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
              {fleet.map((u) => (
                <li key={u.unit} className="rounded-[3px] border border-bone-50/[0.08] p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[0.8125rem]">{u.unit}</span>
                    <span className="t-mono text-[0.625rem] uppercase tracking-[0.1em] text-bone-50/55">{u.state}</span>
                  </div>
                  <div className="mt-3 h-1 overflow-hidden rounded-full bg-bone-50/10">
                    <div className="h-full rounded-full bg-bone-50/70" style={{ width: `${u.battery}%` }} />
                  </div>
                  <div className="t-mono mt-2 flex justify-between text-bone-50/55">
                    <span>Battery {u.battery}%</span>
                    <span>Link {u.link}</span>
                  </div>
                </li>
              ))}
              <li className="t-mono px-1 pt-2 text-bone-50/55">Sample fleet — illustrative states only.</li>
            </ul>
          )}
          <div className="border-t border-bone-50/[0.08] p-3">
            <div className="t-mono text-bone-50/55">Selected</div>
            <div className="mt-1 text-[0.8125rem]">{mission.aircraft}</div>
            <div className="t-mono text-bone-50/55">{mission.date}</div>
          </div>
        </div>

        {/* Map */}
        <div className="relative min-w-0">
          <div
            ref={viewportRef}
            className={cn(
              "relative h-[min(64vw,440px)] touch-none overflow-hidden bg-ink-850 lg:h-full",
              dragging ? "cursor-grabbing" : "cursor-grab",
            )}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerLeave={() => setCursor(null)}
            onDoubleClick={() => zoomBy(1.6)}
            aria-label="Interactive map preview. Drag to pan; use the zoom controls to zoom."
            role="application"
          >
            <div
              className="absolute left-0 top-0 origin-top-left"
              style={{
                width: MAP.width,
                height: MAP.height,
                transform: `translate3d(${tx}px, ${ty}px, 0) scale(${s})`,
                transition,
              }}
            >
              {/* Base imagery always present for continuity */}
              <Image src="/media/map/basemap.webp" alt="" fill unoptimized className="pointer-events-none select-none object-cover" draggable={false} />
              <div
                className="absolute inset-0 bg-ink-950 transition-opacity duration-700"
                style={{ opacity: layer === "imagery" ? 0.12 : layer === "analysis" ? 0.55 : 0.92 }}
              />
              <div className="absolute inset-0 transition-opacity duration-700" style={{ opacity: layer === "analysis" ? 1 : 0 }}>
                <Image src="/media/map/analysis.webp" alt="" fill unoptimized className="pointer-events-none object-cover" draggable={false} />
              </div>
              <div className="absolute inset-0 transition-opacity duration-700" style={{ opacity: layer === "terrain" ? 1 : 0 }}>
                <Image
                  src="/media/map/relief.webp"
                  alt=""
                  fill
                  unoptimized
                  className="pointer-events-none object-cover opacity-[0.22] grayscale"
                  draggable={false}
                />
                <Image src="/media/map/contours.svg" alt="" fill unoptimized className="pointer-events-none object-cover" draggable={false} />
              </div>

              {/* Vector overlays */}
              <svg viewBox={`0 0 ${MAP.width} ${MAP.height}`} className="absolute inset-0 size-full overflow-visible" aria-hidden="true">
                {missions.map((m) => {
                  const sel = m.id === missionId;
                  return (
                    <polygon
                      key={m.id}
                      points={m.polygon.map((p) => p.join(",")).join(" ")}
                      fill={sel ? "rgba(255,106,43,0.06)" : "rgba(242,241,237,0.02)"}
                      stroke={sel ? "var(--color-signal)" : "rgba(242,241,237,0.35)"}
                      strokeWidth={sel ? 1.5 : 1}
                      strokeDasharray={sel ? undefined : "4 4"}
                      vectorEffect="non-scaling-stroke"
                      className="cursor-pointer"
                      onClick={() => !sel && selectMission(m)}
                    />
                  );
                })}
                <polyline
                  points={path.map((p) => p.join(",")).join(" ")}
                  fill="none"
                  stroke="rgba(242,241,237,0.55)"
                  strokeWidth={1}
                  strokeDasharray="3 5"
                  vectorEffect="non-scaling-stroke"
                  className="pointer-events-none"
                />
                {aircraftPos ? (
                  <polyline
                    points={path
                      .slice(0, Math.max(1, Math.ceil((replay ?? 0) * (path.length - 1)) + 1))
                      .map((p) => p.join(","))
                      .concat(aircraftPos.join(","))
                      .join(" ")}
                    fill="none"
                    stroke="var(--color-signal)"
                    strokeWidth={1.6}
                    vectorEffect="non-scaling-stroke"
                    className="pointer-events-none"
                  />
                ) : null}
              </svg>

              {/* Mission label */}
              <div
                className="pointer-events-none absolute"
                style={{
                  left: mission.polygon[0]![0],
                  top: mission.polygon[0]![1],
                  transform: `translate(0, -100%) scale(${1 / s})`,
                  transformOrigin: "0 100%",
                  transition,
                }}
              >
                <span className="t-mono block whitespace-nowrap bg-signal px-1.5 py-0.5 text-[0.625rem] uppercase tracking-[0.1em] text-ink-950">
                  {mission.id} · {mission.name}
                </span>
              </div>

              {/* Findings */}
              {visibleFindings.map((f, i) => {
                const sel = f.id === findingId;
                return (
                  <button
                    key={f.id}
                    onClick={() => selectFinding(f)}
                    aria-label={`Finding ${f.id}: ${f.title}`}
                    className="group absolute"
                    style={{ left: f.x, top: f.y, transform: `translate(-50%, -50%) scale(${1 / s})`, transition }}
                  >
                    <span
                      className={cn(
                        "relative grid size-7 place-items-center rounded-full border text-[0.6875rem] font-medium tabular-nums transition-transform duration-300",
                        sel ? "scale-125 text-ink-950" : "bg-ink-950/80 text-bone-50 group-hover:scale-110",
                      )}
                      style={{ borderColor: severityColor[f.severity], background: sel ? severityColor[f.severity] : undefined }}
                    >
                      {i + 1}
                      {sel && !reduce ? (
                        <span className="absolute inset-0 animate-ping rounded-full border" style={{ borderColor: severityColor[f.severity] }} />
                      ) : null}
                    </span>
                  </button>
                );
              })}

              {aircraftPos ? (
                <div
                  className="pointer-events-none absolute"
                  style={{ left: aircraftPos[0], top: aircraftPos[1], transform: `translate(-50%, -50%) scale(${1 / s})` }}
                >
                  <span className="grid size-6 place-items-center rounded-full bg-signal shadow-[0_0_0_6px_rgba(255,106,43,0.2)]">
                    <LogoMark className="h-3 w-auto text-ink-950" aria-hidden="true" />
                  </span>
                </div>
              ) : null}
            </div>

            {/* Map chrome */}
            <div className="pointer-events-none absolute inset-0">
              <div className="pointer-events-auto absolute left-3 top-3 flex rounded-[3px] border border-bone-50/10 bg-ink-950/80 p-0.5 backdrop-blur-md" role="radiogroup" aria-label="Map layer">
                {LAYERS.map((l) => (
                  <button
                    key={l.id}
                    role="radio"
                    aria-checked={layer === l.id}
                    onClick={() => setLayer(l.id)}
                    className={cn(
                      "rounded-[2px] px-2.5 py-1.5 text-[0.75rem] transition-colors",
                      layer === l.id ? "bg-bone-50 text-ink-950" : "text-bone-50/65 hover:text-bone-50",
                    )}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
              <div className="pointer-events-auto absolute right-3 top-3 flex flex-col overflow-hidden rounded-[3px] border border-bone-50/10 bg-ink-950/80 backdrop-blur-md">
                <MapButton label="Zoom in" onClick={() => zoomBy(1.5)}>
                  <path d="M8 3v10M3 8h10" />
                </MapButton>
                <MapButton label="Zoom out" onClick={() => zoomBy(1 / 1.5)}>
                  <path d="M3 8h10" />
                </MapButton>
                <MapButton label="Reset view to mission" onClick={resetView}>
                  <path d="M8 2v3M8 11v3M2 8h3M11 8h3" />
                  <circle cx="8" cy="8" r="2.5" fill="none" />
                </MapButton>
              </div>

              {/* Legend for analysis layer */}
              <AnimatePresence>
                {layer !== "imagery" ? (
                  <motion.div
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 6 }}
                    className="absolute bottom-10 left-3 rounded-[3px] border border-bone-50/10 bg-ink-950/85 p-2.5 backdrop-blur-md"
                  >
                    {layer === "analysis" ? (
                      <div className="t-mono space-y-1.5 text-[0.625rem] text-bone-50/70">
                        <div className="text-bone-50/60">Vegetation index (ExG)</div>
                        <div className="h-1.5 w-36 rounded-full" style={{ background: "linear-gradient(90deg,#c48c3c,#e9b949,#8dbf63,#cdee91)" }} />
                        <div className="flex justify-between">
                          <span>Low</span>
                          <span>High</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="size-2 rounded-[1px] bg-data-water" /> Water (segmented)
                        </div>
                      </div>
                    ) : (
                      <div className="t-mono space-y-1 text-[0.625rem] text-bone-50/70">
                        <div className="text-bone-50/60">Terrain · USGS 3DEP</div>
                        <div>Contours 20 m · index 100 m</div>
                      </div>
                    )}
                  </motion.div>
                ) : null}
              </AnimatePresence>

              <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 bg-gradient-to-t from-ink-950/80 to-transparent px-3 pb-2 pt-6">
                <div className="flex items-end gap-4">
                  <div>
                    <div className="h-1.5 border-x border-b border-bone-50/70" style={{ width: barPx }} />
                    <div className="t-mono mt-1 text-[0.625rem] text-bone-50/70">
                      {barMeters >= 1000 ? `${barMeters / 1000} km` : `${barMeters} m`}
                    </div>
                  </div>
                  <div className="t-mono hidden text-[0.625rem] text-bone-50/60 sm:block" suppressHydrationWarning>
                    {cursor ? fmtCoord(toLatLon(cursor.x, cursor.y)) : fmtCoord(toLatLon(cv.cx, cv.cy))}
                  </div>
                </div>
                <div className="t-mono max-w-[50%] truncate text-right text-[0.5625rem] text-bone-50/55">{MAP.attribution}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Right panel */}
        <div className="flex min-h-0 flex-col border-t border-bone-50/[0.08] bg-ink-900/60 lg:border-l lg:border-t-0">
          <div className="flex border-b border-bone-50/[0.08] p-1.5" role="tablist" aria-label="Mission detail">
            {(["findings", "flight", "processing"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={panel === t}
                onClick={() => setPanel(t)}
                className={cn(
                  "flex-1 rounded-[3px] py-1.5 text-[0.75rem] capitalize transition-colors",
                  panel === t ? "bg-bone-50/[0.08] text-bone-50" : "text-bone-50/50 hover:text-bone-50",
                )}
              >
                {t}
              </button>
            ))}
          </div>

          <div className="min-h-[320px] flex-1 overflow-y-auto p-3 lg:min-h-0">
            {panel === "findings" ? (
              finding ? (
                <FindingDetail finding={finding} onBack={() => setFindingId(null)} />
              ) : (
                <div>
                  <div className="no-scrollbar -mx-1 flex gap-1 overflow-x-auto px-1 pb-3" role="radiogroup" aria-label="Analysis category">
                    {categories.map((c) => (
                      <button
                        key={c}
                        role="radio"
                        aria-checked={category === c}
                        onClick={() => setCategory(c)}
                        className={cn(
                          "shrink-0 rounded-full border px-2.5 py-1 text-[0.6875rem] transition-colors",
                          category === c ? "border-bone-50/40 bg-bone-50/10 text-bone-50" : "border-bone-50/10 text-bone-50/55 hover:text-bone-50",
                        )}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                  <ul className="space-y-1.5">
                    {visibleFindings.map((f) => (
                      <li key={f.id}>
                        <button
                          onClick={() => selectFinding(f)}
                          className="w-full rounded-[3px] border border-bone-50/[0.08] p-3 text-left transition-colors hover:border-bone-50/20 hover:bg-bone-50/[0.03]"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-2 text-[0.8125rem]">
                              <span className="size-2 shrink-0 rounded-full" style={{ background: severityColor[f.severity] }} />
                              {f.title}
                            </span>
                            <span className="t-mono text-bone-50/55">{f.id}</span>
                          </div>
                          <div className="t-mono mt-1.5 flex justify-between text-bone-50/60">
                            <span>{f.category}</span>
                            <span>conf. {f.confidence.toFixed(2)}</span>
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                  <p className="t-mono mt-4 text-bone-50/55">
                    Findings, scores and areas are sample values that demonstrate the interface — not results of real analysis.
                  </p>
                </div>
              )
            ) : null}

            {panel === "flight" ? (
              <div>
                <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[3px] border border-bone-50/[0.08] bg-bone-50/[0.08]">
                  {(
                    [
                      ["Aircraft", mission.aircraft],
                      ["Altitude", mission.flight.altitude],
                      ["GSD", mission.flight.gsd],
                      ["Images", mission.flight.images.toLocaleString("en-US")],
                      ["Coverage", mission.flight.coverage],
                      ["Duration", mission.flight.duration],
                      ["Sorties", String(mission.flight.sorties)],
                      ["Pattern", mission.path.vertical ? "N–S lanes" : "E–W lanes"],
                    ] as const
                  ).map(([k, v]) => (
                    <div key={k} className="bg-ink-900 p-2.5">
                      <dt className="t-mono text-bone-50/55">{k}</dt>
                      <dd className="mt-0.5 text-[0.8125rem]">{v}</dd>
                    </div>
                  ))}
                </dl>
                <AltitudeProfile />
                <button
                  onClick={() => {
                    setReplay(0);
                    setReplayRun((n) => n + 1);
                  }}
                  className="mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-[3px] border border-bone-50/15 text-[0.8125rem] transition-colors hover:border-bone-50/40 hover:bg-bone-50/[0.04]"
                >
                  <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
                    <path d="M4 3l9 5-9 5z" fill="currentColor" />
                  </svg>
                  {replay !== null && replay < 1 ? "Replaying track…" : "Replay flight track"}
                </button>
                <p className="t-mono mt-3 text-bone-50/55">Sample flight record for demonstration.</p>
              </div>
            ) : null}

            {panel === "processing" ? (
              <div>
                <ol className="relative space-y-0">
                  {mission.pipeline.map((p, i) => (
                    <li key={p.label} className="relative flex gap-3 pb-5 last:pb-0">
                      {i < mission.pipeline.length - 1 ? (
                        <span
                          aria-hidden="true"
                          className={cn("absolute left-[7px] top-4 h-full w-px", p.state === "done" ? "bg-bone-50/40" : "bg-bone-50/10")}
                        />
                      ) : null}
                      <span
                        className={cn(
                          "relative mt-0.5 grid size-[15px] shrink-0 place-items-center rounded-full border",
                          p.state === "done" && "border-bone-50/60 bg-bone-50/80",
                          p.state === "active" && "border-signal",
                          p.state === "pending" && "border-bone-50/20",
                        )}
                      >
                        {p.state === "active" ? <span className="size-1.5 animate-pulse rounded-full bg-signal" /> : null}
                      </span>
                      <div>
                        <div className="text-[0.8125rem]">{p.label}</div>
                        <div className="t-mono text-bone-50/55">
                          {p.state === "done" ? "Complete" : p.state === "active" ? "In progress" : "Queued"}
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
                <div className="mt-5 rounded-[3px] border border-bone-50/[0.08] p-3">
                  <div className="t-mono text-bone-50/55">Human review</div>
                  <p className="mt-1 text-[0.8125rem] leading-relaxed text-bone-50/75">
                    Every finding is confirmed by an analyst before it reaches ORYN Portal.
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function MapButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid size-8 place-items-center border-b border-bone-50/10 text-bone-50/75 transition-colors last:border-b-0 hover:bg-bone-50/10 hover:text-bone-50"
    >
      <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}

function FindingDetail({ finding: f, onBack }: { finding: Finding; onBack: () => void }) {
  const k = 1.1; // chip magnification relative to basemap pixels
  const ll = toLatLon(f.x, f.y);
  return (
    <motion.div initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.35 }}>
      <button onClick={onBack} className="t-mono mb-3 flex items-center gap-1.5 text-bone-50/55 hover:text-bone-50">
        <span aria-hidden="true">←</span> All findings
      </button>
      <div
        className="relative h-36 overflow-hidden rounded-[3px] border border-bone-50/10 bg-ink-850"
        style={{
          backgroundImage: "url(/media/map/basemap.webp)",
          backgroundSize: `${MAP.width * k}px ${MAP.height * k}px`,
          backgroundPosition: `calc(50% + ${(MAP.width * k) / 2 - f.x * k}px) calc(50% + ${(MAP.height * k) / 2 - f.y * k}px)`,
        }}
      >
        <div className="absolute left-1/2 top-1/2 size-14 -translate-x-1/2 -translate-y-1/2 border" style={{ borderColor: severityColor[f.severity] }}>
          <span className="t-mono absolute -top-4 left-0 whitespace-nowrap text-[0.5625rem] uppercase tracking-[0.1em]" style={{ color: severityColor[f.severity] }}>
            {f.category} · {f.confidence.toFixed(2)}
          </span>
        </div>
      </div>
      <div className="mt-3 flex items-start justify-between gap-2">
        <h4 className="text-[0.9375rem] font-medium leading-snug">{f.title}</h4>
        <span
          className="t-mono shrink-0 rounded-[2px] px-1.5 py-0.5 text-[0.625rem] uppercase tracking-[0.1em] text-ink-950"
          style={{ background: severityColor[f.severity] }}
        >
          {severityLabel[f.severity]}
        </span>
      </div>
      <p className="mt-2 text-[0.8125rem] leading-relaxed text-bone-50/70">{f.note}</p>
      <dl className="t-mono mt-4 space-y-1.5 text-bone-50/55">
        <div className="flex justify-between">
          <dt>ID</dt>
          <dd className="text-bone-50/80">{f.id}</dd>
        </div>
        {f.area ? (
          <div className="flex justify-between">
            <dt>Area</dt>
            <dd className="text-bone-50/80">{f.area}</dd>
          </div>
        ) : null}
        <div className="flex justify-between">
          <dt>Location</dt>
          <dd className="text-bone-50/80">{fmtCoord(ll)}</dd>
        </div>
        <div>
          <div className="flex justify-between">
            <dt>Model confidence</dt>
            <dd className="text-bone-50/80">{f.confidence.toFixed(2)}</dd>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-bone-50/10">
            <div className="h-full rounded-full" style={{ width: `${f.confidence * 100}%`, background: severityColor[f.severity] }} />
          </div>
        </div>
      </dl>
      <p className="t-mono mt-4 text-bone-50/55">Sample finding. Interpretation shown for demonstration only.</p>
    </motion.div>
  );
}

function AltitudeProfile() {
  // Illustrative altitude trace: climb, survey lanes, return.
  const pts = useMemo(() => {
    const out: string[] = [];
    for (let i = 0; i <= 100; i++) {
      const t = i / 100;
      let a = 0;
      if (t < 0.08) a = t / 0.08;
      else if (t > 0.92) a = (1 - t) / 0.08;
      else a = 1 - 0.02 * Math.sin(t * 60);
      out.push(`${(t * 280).toFixed(1)},${(52 - a * 40).toFixed(1)}`);
    }
    return out.join(" ");
  }, []);
  return (
    <div className="mt-3 rounded-[3px] border border-bone-50/[0.08] p-3">
      <div className="t-mono flex justify-between text-bone-50/55">
        <span>Altitude profile</span>
        <span>Sample</span>
      </div>
      <svg viewBox="0 0 280 56" className="mt-2 h-14 w-full" preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" x2="280" y1="12" y2="12" stroke="rgba(242,241,237,0.1)" strokeDasharray="2 3" />
        <polyline points={pts} fill="none" stroke="rgba(242,241,237,0.8)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}
