"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Person, SceneBackdrop, SceneHedge, zonePath } from "@/components/edge/perception-scene";
import {
  CHAIR_BOX,
  FPS,
  LOOP_S,
  PERSIST_S,
  boxFor,
  confidence,
  eventAt,
  feetAt,
  inPolygon,
  isOccluded,
  isVisible,
  narratedStage,
  timeline,
  trail,
  ZONE,
  type EventState,
} from "@/components/edge/perception-sim";
import { StatusTag } from "@/components/ui/primitives";
import { exampleRule, pipelineStages } from "@/content/sensordyme";
import { cn } from "@/lib/cn";

const TRACK_COLOR = { 1: "var(--color-data-water)", 2: "var(--color-data-violet)" } as const;
const STATIC_T = timeline.confirmT + 1.2; // reduced motion: a frame just after confirmation
const IDS = [1, 2] as const;

/** Advances scene time while visible and playing; ~30 fps, like the camera. */
function useSceneClock(playing: boolean, ref: React.RefObject<HTMLElement | null>) {
  const [t, setT] = useState(0);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => setInView(!!entries.at(-1)?.isIntersecting), { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  useEffect(() => {
    if (!playing || !inView) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const tick = (now: number) => {
      acc += Math.min(0.1, (now - last) / 1000);
      last = now;
      if (acc >= 1 / FPS) {
        const step = acc;
        acc = 0;
        setT((v) => (v + step) % LOOP_S);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, inView]);
  return [t, setT] as const;
}

const stateTone: Record<EventState, string> = {
  idle: "text-bone-50/50",
  observed: "text-data-amber",
  developing: "text-data-amber",
  confirmed: "text-signal",
  resolved: "text-bone-50/70",
};

const noopSubscribe = () => () => {};

export function PerceptionStory() {
  // Server HTML always renders the playing state; switch to the static frame only after hydration.
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const reduce = useReducedMotion() && hydrated;
  const rootRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(true);
  const [manual, setManual] = useState<number | null>(null);
  const [clockT, setT] = useSceneClock(playing && !reduce, rootRef);

  const t = reduce ? STATIC_T : clockT;
  const stage = manual ?? (reduce ? pipelineStages.length - 1 : narratedStage(t));
  const info = pipelineStages[stage]!;
  const ev = eventAt(t);
  const show = (k: number) => stage >= k;

  const select = (i: number) => setManual(i);
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const last = pipelineStages.length - 1;
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? Math.min(last, i + 1)
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? Math.max(0, i - 1)
      : e.key === "Home" ? 0
      : e.key === "End" ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    select(next);
    document.getElementById(`pp-${pipelineStages[next]!.id}`)?.focus();
  };

  const people = IDS.map((id) => {
    const at = feetAt(id, t);
    const prev = feetAt(id, t - 0.1);
    const moving = Math.hypot(at[0] - prev[0], at[1] - prev[1]) > 0.4;
    return { id, at, moving, box: boxFor(at), visible: isVisible(id, t), occluded: isOccluded(id, t), inZone: inPolygon(at, ZONE) };
  });
  const p2 = people[1]!;
  const alerting = ev.state === "confirmed";

  const readout: string[] = [
    `frame ${String(Math.floor(t * FPS)).padStart(5, "0")} · 640×480`,
    // One line per kind of knowledge, so the panel keeps a steady height while the scene plays.
    ...(show(1) ? [[...people.filter((p) => p.visible).map((p) => `person ${confidence(p.id, t).toFixed(2)}`), `chair ${CHAIR_BOX.score.toFixed(2)}`].join(" · ")] : []),
    ...(show(2) ? [people.filter((p) => p.at[0] < 980).map((p) => `ID ${p.id} ${p.occluded ? "held (occluded)" : "tracked"}`).join(" · ")] : []),
    ...(show(3) ? [`ID 2 → pool zone · ${p2.inZone ? "inside" : "outside"}`] : []),
    ...(show(4) ? [`event · ${ev.state}`] : []),
    ...(show(5) ? [`persist ${Math.min(ev.dwell, PERSIST_S).toFixed(1)} / ${PERSIST_S} s`] : []),
    ...(show(6) ? [alerting ? "→ buzzer · event log · phone" : "monitoring · no rule met"] : []),
  ];

  return (
    <div ref={rootRef} className="grid gap-6 lg:grid-cols-12 lg:gap-8 [&>*]:min-w-0">
      <figure className="order-1 lg:order-none lg:col-span-8">
        <div className="relative overflow-hidden rounded-[3px] border border-bone-50/10 bg-ink-950">
          <svg viewBox="0 0 960 600" className="block h-auto w-full" role="img" aria-label={`Illustrative camera view of a backyard pool. Current stage: ${info.name}. ${info.question}`}>
            <defs>
              <radialGradient id="pp-vignette" cx="50%" cy="45%" r="75%">
                <stop offset="60%" stopColor="#060707" stopOpacity="0" />
                <stop offset="100%" stopColor="#060707" stopOpacity="0.85" />
              </radialGradient>
              <pattern id="pp-scan" width="4" height="4" patternUnits="userSpaceOnUse">
                <path d="M0 0H4" stroke="rgb(242 241 237 / 0.035)" />
              </pattern>
            </defs>
            <rect width="960" height="600" fill="#0a0c0d" />
            <SceneBackdrop />

            {/* Context: the zone, drawn beneath people */}
            {show(3) ? (
              <path
                d={zonePath()}
                fill={alerting ? "rgb(255 106 43 / 0.12)" : p2.inZone ? "rgb(233 185 73 / 0.09)" : "rgb(233 185 73 / 0.03)"}
                stroke={alerting ? "var(--color-signal)" : "var(--color-data-amber)"}
                strokeWidth="1.5"
                strokeDasharray="10 7"
                className="transition-[fill] duration-500"
              />
            ) : null}

            {/* Tracking: recent motion */}
            {show(2)
              ? IDS.map((id) => {
                  const pts = trail(id, t);
                  return pts.length > 1 ? (
                    <polyline key={id} points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke={TRACK_COLOR[id]} strokeOpacity="0.55" strokeWidth="2" strokeDasharray="2 5" />
                  ) : null;
                })
              : null}

            {people.map((p) => (
              <Person key={p.id} at={p.at} phase={t * 7 + p.id} moving={p.moving} />
            ))}
            <SceneHedge />

            {/* Perception: detections */}
            {show(1) ? (
              <g className="font-mono">
                <DetBox x={CHAIR_BOX.x} y={CHAIR_BOX.y} w={CHAIR_BOX.w} h={CHAIR_BOX.h} label={`chair ${CHAIR_BOX.score.toFixed(2)}`} color="rgb(242 241 237 / 0.55)" />
                {people.map((p) => {
                  if (!p.visible && !(show(2) && p.occluded)) return null;
                  const color = show(2) ? TRACK_COLOR[p.id] : "#f2f1ed";
                  const held = p.occluded;
                  const label = show(2) ? `ID ${p.id}${held ? " · held" : ""}` : `person ${confidence(p.id, t).toFixed(2)}`;
                  return (
                    <DetBox
                      key={p.id}
                      {...p.box}
                      label={label}
                      color={p.id === 2 && alerting ? "var(--color-signal)" : color}
                      dashed={held}
                    />
                  );
                })}
              </g>
            ) : null}

            {/* Context: membership is judged at the feet */}
            {show(3)
              ? people.filter((p) => p.at[0] < 980).map((p) => (
                  <g key={p.id}>
                    <circle cx={p.at[0]} cy={p.at[1]} r="5" fill={p.inZone ? "var(--color-data-amber)" : "#f2f1ed"} />
                    <circle cx={p.at[0]} cy={p.at[1]} r="10" fill="none" stroke={p.inZone ? "var(--color-data-amber)" : "#f2f1ed"} strokeOpacity="0.5" />
                  </g>
                ))
              : null}
            {show(3) ? (
              <text x={ZONE[3]![0] + 14} y={ZONE[3]![1] - 14} className="font-mono" fontSize="15" letterSpacing="1.5" fill={alerting ? "var(--color-signal)" : "var(--color-data-amber)"}>
                POOL ZONE · RESTRICTED
              </text>
            ) : null}

            {/* Event + verification: dwell timer at the subject */}
            {show(4) && ev.state !== "idle" && p2.at[0] < 960 ? (
              <g transform={`translate(${p2.box.x + p2.box.w + 10} ${p2.box.y + 4})`} className="font-mono">
                <rect width="148" height={show(5) ? 52 : 30} rx="2" fill="rgb(6 7 7 / 0.88)" stroke="rgb(242 241 237 / 0.15)" />
                <text x="10" y="20" fontSize="14" fill={ev.state === "confirmed" ? "var(--color-signal)" : "var(--color-data-amber)"}>
                  {ev.state.toUpperCase()}
                </text>
                {show(5) ? (
                  <>
                    <rect x="10" y="32" width="128" height="4" fill="rgb(242 241 237 / 0.12)" />
                    <rect x="10" y="32" width={128 * Math.min(1, ev.dwell / PERSIST_S)} height="4" fill={ev.dwell >= PERSIST_S ? "var(--color-signal)" : "var(--color-data-amber)"} />
                    <text x="138" y="48" fontSize="10" textAnchor="end" fill="rgb(242 241 237 / 0.6)">
                      {Math.min(ev.dwell, PERSIST_S).toFixed(1)} / {PERSIST_S} s
                    </text>
                  </>
                ) : null}
              </g>
            ) : null}

            <rect width="960" height="600" fill="url(#pp-scan)" />
            <rect width="960" height="600" fill="url(#pp-vignette)" />

            {/* Camera HUD */}
            <g className="font-mono" fontSize="14" letterSpacing="1">
              <text x="24" y="36" fill="rgb(242 241 237 / 0.7)">CAM 01 · NoIR · 640×480</text>
              <circle cx="874" cy="31" r="5" fill="var(--color-data-alert)" opacity={Math.floor(t * 2) % 2 ? 1 : 0.35} />
              <text x="936" y="36" textAnchor="end" fill="rgb(242 241 237 / 0.7)">REC</text>
              <text x="936" y="580" textAnchor="end" fill="rgb(242 241 237 / 0.45)">
                f {String(Math.floor(t * FPS)).padStart(5, "0")}
              </text>
            </g>
          </svg>

          {/* Alert: what happens in the room and on the phone */}
          <AnimatePresence>
            {show(6) && alerting ? (
              <motion.div
                key="alert"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 12 }}
                transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                className="absolute bottom-8 right-3 w-[min(280px,60%)] rounded-[4px] border border-signal/40 bg-ink-950/95 p-3 shadow-2xl backdrop-blur-md md:bottom-12 md:right-5 md:p-4"
              >
                <div className="t-mono flex items-center justify-between text-signal">
                  <span className="flex items-center gap-2">
                    <span className="relative flex size-2">
                      <span className="absolute inset-0 rounded-full bg-signal motion-safe:animate-ping" />
                      <span className="relative size-2 rounded-full bg-signal" />
                    </span>
                    Confirmed
                  </span>
                  <span className="text-bone-50/50">Buzzer on</span>
                </div>
                <p className="mt-2 text-[0.8125rem] font-medium leading-snug sm:text-[0.9375rem]">Person in pool zone for {PERSIST_S} s</p>
                <p className="t-mono mt-1 hidden text-bone-50/55 sm:block">Event logged on device · Phone alert (in development)</p>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
        <figcaption className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="t-mono text-[0.6875rem] text-bone-50/60">Illustrative scene and timings · logic modeled on the SensorDyme prototype software</p>
          {!reduce ? (
            <div className="flex items-center gap-4">
              <button type="button" onClick={() => setPlaying((p) => !p)} className="t-mono text-bone-50/70 underline-offset-4 hover:text-bone-50 hover:underline">
                {playing ? "Pause" : "Play"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setManual(null);
                  setT(0);
                  setPlaying(true);
                }}
                className="t-mono text-bone-50/70 underline-offset-4 hover:text-bone-50 hover:underline"
              >
                Replay story
              </button>
            </div>
          ) : null}
        </figcaption>
      </figure>

      <div className="order-3 lg:order-none lg:col-span-4">
        <AnimatePresence mode="wait">
          <motion.div
            key={info.id}
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 1 } : { opacity: 0, y: -8 }}
            transition={{ duration: reduce ? 0 : 0.3 }}
            className="border-t border-bone-50/15 pt-5"
            id="pp-panel"
            role="tabpanel"
            aria-labelledby={`pp-${info.id}`}
          >
            <p className="t-eyebrow text-bone-50/50">
              {String(stage + 1).padStart(2, "0")} · {info.question}
            </p>
            <h3 className="t-h3 mt-3">{info.name}</h3>
            <p className="t-body mt-3 text-bone-50/65">{info.body}</p>
            <p className="t-mono mt-4 text-bone-50/55">{info.detail}</p>
            <div className="mt-4">
              <StatusTag tone={info.status === "Verified on prototype" ? "signal" : "neutral"}>{info.status}</StatusTag>
            </div>
          </motion.div>
        </AnimatePresence>

        <div className="mt-6 border-t border-bone-50/10 pt-5" aria-hidden="true">
          <p className="t-eyebrow text-bone-50/50">What the device knows</p>
          <ul className="t-mono mt-3 min-h-[9.5rem] space-y-1 text-bone-50/75">
            {readout.map((line, i) => (
              <li key={i} className={cn(line.startsWith("event") && stateTone[ev.state], line.startsWith("→") && "text-signal")}>
                {line}
              </li>
            ))}
          </ul>
        </div>
        <p className="t-mono mt-4 border-t border-bone-50/10 pt-4 text-[0.6875rem] leading-relaxed text-bone-50/55">
          Example rule: {exampleRule.condition.toLowerCase()} for longer than {exampleRule.persist} s → {exampleRule.action.toLowerCase()}.
        </p>
      </div>

      {/* Stage rail */}
      <div role="tablist" aria-label="SensorDyme pipeline stages" className="no-scrollbar order-2 -mx-[var(--gutter)] flex overflow-x-auto px-[var(--gutter)] lg:order-none lg:col-span-12 lg:mx-0 lg:grid lg:grid-cols-7 lg:px-0">
        {pipelineStages.map((s, i) => {
          const active = i === stage;
          const passed = i < stage;
          return (
            <button
              key={s.id}
              id={`pp-${s.id}`}
              role="tab"
              aria-selected={active}
              aria-controls="pp-panel"
              tabIndex={active ? 0 : -1}
              onClick={() => select(i)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className="group relative min-w-[8.5rem] shrink-0 border-t border-bone-50/15 py-4 pr-4 text-left lg:min-w-0"
            >
              <span aria-hidden="true" className={cn("absolute inset-x-0 -top-px h-px origin-left transition-transform duration-500", active || passed ? "scale-x-100" : "scale-x-0", active ? "bg-signal" : "bg-bone-50/60")} />
              <span className={cn("t-mono block transition-colors", active ? "text-signal" : "text-bone-50/50")}>{String(i + 1).padStart(2, "0")}</span>
              <span className={cn("mt-1 block text-[0.9375rem] font-medium tracking-[-0.01em] transition-colors", active ? "text-bone-50" : "text-bone-50/60 group-hover:text-bone-50/85")}>
                {s.name}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DetBox({ x, y, w, h, label, color, dashed }: { x: number; y: number; w: number; h: number; label: string; color: string; dashed?: boolean }) {
  const fs = 13;
  const tagW = label.length * fs * 0.62 + 12;
  const above = y > 26;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} fill="none" stroke={color} strokeWidth="1.6" strokeDasharray={dashed ? "6 5" : undefined} />
      <rect x={x - 0.8} y={above ? y - 22 : y} width={tagW} height="22" fill={color} />
      <text x={x + 6} y={above ? y - 6 : y + 16} fontSize={fs} fill="#0a0b0c">
        {label}
      </text>
    </g>
  );
}
