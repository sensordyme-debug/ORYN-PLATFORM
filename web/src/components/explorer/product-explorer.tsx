"use client";

import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LabelSink, ProductStage } from "@/components/explorer/product-stage";
import { StatusTag } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

export type ExplorerSystem = {
  id: string;
  n: string;
  label: string;
  name: string;
  body: string;
  provenance: string;
  status: string;
  /** Optional deeper link from this system (e.g. to the intelligence pipeline). */
  link?: { href: string; label: string };
};

export type StageModule = {
  createStage: (host: HTMLElement, initial: string, opts: { reduceMotion: boolean; onLabel: LabelSink }) => ProductStage;
  webglAvailable: () => boolean;
};

type Mode = "loading" | "3d" | "fallback";

/**
 * Shared SensorDyme product explorer: a code-built 3D model (Three.js,
 * loaded on demand) inspected system by system, with a 2D blueprint as
 * poster and no-WebGL fallback. The text panel carries the same
 * information as the model, so the 3D view is never the only source.
 */
export function ProductExplorer({
  systems,
  idPrefix,
  loadStage,
  drawing,
  tag,
  note,
  listLabel,
  description,
}: {
  systems: ExplorerSystem[];
  idPrefix: string;
  loadStage: () => Promise<StageModule>;
  /** 2D blueprint for the active system; `withCallouts` is true in fallback mode. */
  drawing: (activeId: string, withCallouts: boolean) => ReactNode;
  tag: string;
  note: string;
  listLabel: string;
  description: string;
}) {
  const reduce = !!useReducedMotion();
  const wrapRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<ProductStage | null>(null);
  const [mode, setMode] = useState<Mode>("loading");
  const [index, setIndex] = useState(0);
  const sys = systems[index]!;
  const stepRef = useRef(systems[0]!.id);
  const loaderRef = useRef(loadStage);

  // Load Three.js only as the explorer approaches the viewport.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let cancelled = false;
    let visIO: IntersectionObserver | null = null;
    const loadIO = new IntersectionObserver(
      async (entries) => {
        // A fast scroll can batch several entries; only the latest reflects the current state.
        if (!entries.at(-1)?.isIntersecting) return;
        loadIO.disconnect();
        const mod = await loaderRef.current();
        if (cancelled || !hostRef.current) return;
        if (!mod.webglAvailable()) return setMode("fallback");
        try {
          const stage = mod.createStage(hostRef.current, stepRef.current, {
            reduceMotion: reduce,
            onLabel: (pos) => {
              const el = labelRef.current;
              if (!el) return;
              el.style.opacity = pos ? "1" : "0";
              if (!pos) return;
              el.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
              // The tag flips to the left of its anchor only when it would overflow on the right
              // and there is more room on the left, so it stays inside the frame.
              const w = hostRef.current?.clientWidth ?? 0;
              const tagW = el.querySelector<HTMLElement>(".t-mono")?.offsetWidth ?? 160;
              el.dataset.flip = String(pos.x + 52 + tagW > w && pos.x > w / 2);
              // If neither side fits (narrow screens), nudge the tag back inside the frame.
              const tag = el.querySelector<HTMLElement>(".t-mono");
              const frame = hostRef.current?.getBoundingClientRect();
              el.style.setProperty("--shift", "0px");
              if (tag && frame) {
                const r = tag.getBoundingClientRect();
                const shift = r.right > frame.right - 6 ? frame.right - 6 - r.right : r.left < frame.left + 6 ? frame.left + 6 - r.left : 0;
                el.style.setProperty("--shift", `${shift}px`);
              }
            },
          });
          stageRef.current = stage;
          setMode("3d");
          visIO = new IntersectionObserver((entries) => stage.setActive(!!entries.at(-1)?.isIntersecting), { threshold: 0 });
          visIO.observe(wrap);
        } catch {
          setMode("fallback");
        }
      },
      { rootMargin: "600px 0px" },
    );
    loadIO.observe(wrap);
    return () => {
      cancelled = true;
      loadIO.disconnect();
      visIO?.disconnect();
      stageRef.current?.dispose();
      stageRef.current = null;
    };
  }, [reduce]);

  useEffect(() => {
    stepRef.current = sys.id;
    stageRef.current?.setStep(sys.id);
  }, [sys.id]);

  const last = systems.length - 1;
  const go = (i: number) => setIndex(Math.max(0, Math.min(last, i)));
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const next =
      e.key === "ArrowDown" || e.key === "ArrowRight" ? i + 1
      : e.key === "ArrowUp" || e.key === "ArrowLeft" ? i - 1
      : e.key === "Home" ? 0
      : e.key === "End" ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    const n = Math.max(0, Math.min(last, next));
    go(n);
    document.getElementById(`${idPrefix}-sys-${systems[n]!.id}`)?.focus();
  };

  const descId = `${idPrefix}-desc`;
  return (
    <div ref={wrapRef} className="grid gap-6 lg:grid-cols-12 lg:gap-8 [&>*]:min-w-0">
      <div className="lg:col-span-8">
        <div
          role="group"
          aria-roledescription="interactive model"
          aria-label={tag}
          aria-describedby={descId}
          className="relative aspect-square overflow-hidden rounded-[3px] border border-bone-50/[0.08] bg-[radial-gradient(ellipse_at_50%_40%,#1a1d20_0%,#0c0e0f_55%,#060707_100%)] sm:aspect-[4/3] lg:aspect-auto lg:h-[min(74vh,720px)]"
        >
          <p id={descId} className="sr-only">
            {description} Currently showing: {sys.label} — {sys.name}. {sys.status}. The system list and panel beside the model describe each part in text.
          </p>
          <div aria-hidden="true" className="tech-grid absolute inset-0 text-bone-50 opacity-40 [mask-image:radial-gradient(ellipse_at_50%_50%,black,transparent_72%)]" />

          {/* Poster & fallback: the 2D blueprint */}
          <div className={cn("absolute inset-0 grid place-items-center p-6 transition-opacity duration-700 md:p-12", mode === "3d" ? "pointer-events-none opacity-0" : "opacity-100")}>
            {drawing(sys.id, mode === "fallback")}
          </div>

          <div ref={hostRef} className={cn("absolute inset-0 transition-opacity duration-700", mode === "3d" ? "opacity-100" : "opacity-0")} />

          {/* Anchored component label */}
          <div ref={labelRef} aria-hidden="true" className="group/label pointer-events-none absolute left-0 top-0 opacity-0 transition-opacity duration-300" style={{ willChange: "transform" }}>
            {mode === "3d" && index > 0 ? (
              <div className="relative">
                <span className="absolute -left-[5px] -top-[5px] size-2.5 rounded-full bg-signal shadow-[0_0_0_4px_rgba(255,106,43,0.18)]" />
                <span className="absolute left-0 top-0 h-px w-10 origin-left -rotate-[35deg] bg-signal/80 group-data-[flip=true]/label:-rotate-[145deg] md:w-16" />
                <span className="t-mono absolute left-8 top-[-2.4rem] translate-x-[var(--shift,0px)] whitespace-nowrap group-data-[flip=true]/label:left-auto group-data-[flip=true]/label:right-8 md:group-data-[flip=true]/label:right-12 rounded-[2px] border border-bone-50/15 bg-ink-950/85 px-2 py-1 text-[0.6875rem] uppercase tracking-[0.12em] text-bone-50 backdrop-blur-md md:left-12 md:top-[-3.1rem]">
                  {sys.n} · {sys.label}
                </span>
              </div>
            ) : null}
          </div>

          <div className="t-mono pointer-events-none absolute left-4 top-4 flex items-center gap-2 text-[0.6875rem] text-bone-50/60 md:left-5 md:top-5">
            <span className="size-1.5 rounded-full bg-signal" /> {tag}
          </div>
          <div className="absolute bottom-3 left-4 right-4 flex items-center justify-between gap-3 md:bottom-4 md:left-5 md:right-5">
            <p className="t-mono text-[0.6875rem] text-bone-50/55">
              {mode === "loading" ? "Loading 3D model…" : mode === "fallback" ? "Blueprint drawing · 3D unavailable" : "Drag to rotate"}
            </p>
            {mode === "3d" ? (
              <div className="flex gap-1">
                {([["Rotate left", 0.35], ["Rotate right", -0.35]] as const).map(([label, d]) => (
                  <button
                    key={label}
                    type="button"
                    aria-label={label}
                    onClick={() => stageRef.current?.rotateBy(d)}
                    className="grid size-10 place-items-center rounded-[2px] border border-bone-50/15 bg-ink-950/60 text-bone-50/70 transition-colors hover:border-bone-50/50 hover:text-bone-50 md:size-8"
                  >
                    <svg viewBox="0 0 16 16" className={cn("size-3.5", d < 0 && "-scale-x-100")} fill="none" aria-hidden="true">
                      <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v2.8h-2.8" stroke="currentColor" strokeWidth="1.3" />
                    </svg>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <p className="t-mono mt-3 text-[0.6875rem] text-bone-50/60">{note}</p>
      </div>

      <div className="flex flex-col lg:col-span-4">
        <div
          role="tablist"
          aria-label={listLabel}
          aria-orientation="vertical"
          className="no-scrollbar -mx-[var(--gutter)] order-1 flex overflow-x-auto px-[var(--gutter)] lg:order-none lg:mx-0 lg:block lg:px-0"
        >
          {systems.map((s, i) => {
            const on = i === index;
            return (
              <button
                key={s.id}
                id={`${idPrefix}-sys-${s.id}`}
                role="tab"
                aria-selected={on}
                aria-controls={`${idPrefix}-sys-panel`}
                tabIndex={on ? 0 : -1}
                onClick={() => go(i)}
                onKeyDown={(e) => onKeyDown(e, i)}
                className="group flex shrink-0 items-baseline gap-3 border-b border-bone-50/10 px-3 py-3 text-left first:pl-0 lg:w-full lg:gap-4 lg:border-t lg:border-b-0 lg:px-0 lg:last:border-b"
              >
                <span className={cn("t-mono transition-colors", on ? "text-signal" : "text-bone-50/50")}>{s.n}</span>
                <span className={cn("whitespace-nowrap text-[0.9375rem] font-medium tracking-[-0.01em] transition-colors lg:text-[1.0625rem]", on ? "text-bone-50" : "text-bone-50/65 group-hover:text-bone-50/85")}>
                  {s.label}
                </span>
                <span aria-hidden="true" className={cn("ml-auto hidden h-px w-6 transition-colors lg:block", on ? "bg-signal" : "bg-transparent")} />
              </button>
            );
          })}
        </div>

        <div className="order-2 mt-6 lg:order-none lg:mt-8">
          <AnimatePresence mode="wait">
            <motion.div
              key={sys.id}
              id={`${idPrefix}-sys-panel`}
              role="tabpanel"
              aria-labelledby={`${idPrefix}-sys-${sys.id}`}
              initial={reduce ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 1 } : { opacity: 0, y: -8 }}
              transition={{ duration: reduce ? 0 : 0.3 }}
            >
              <p className="t-eyebrow text-bone-50/50">
                {sys.n} · {sys.label}
              </p>
              <h3 className="t-h4 mt-3">{sys.name}</h3>
              <p className="t-small mt-3 text-bone-50/65">{sys.body}</p>
              <div className="mt-5 flex flex-wrap gap-2">
                <StatusTag tone={index === 0 || sys.status === "Verified on prototype" ? "signal" : "neutral"}>{sys.status}</StatusTag>
              </div>
              <p className="t-mono mt-3 text-bone-50/50">{sys.provenance}</p>
              {sys.link ? (
                <Link href={sys.link.href} className="t-mono mt-4 inline-flex items-center gap-2 text-bone-50/80 underline-offset-4 hover:text-bone-50 hover:underline">
                  {sys.link.label} <span aria-hidden="true">→</span>
                </Link>
              ) : null}
            </motion.div>
          </AnimatePresence>
          <div className="mt-6 flex gap-2 lg:hidden">
            <button type="button" onClick={() => go(index - 1)} disabled={index === 0} className="h-11 flex-1 rounded-[2px] border border-bone-50/15 text-[0.875rem] text-bone-50/80 disabled:opacity-30">
              Previous
            </button>
            <button type="button" onClick={() => go(index + 1)} disabled={index === last} className="h-11 flex-1 rounded-[2px] border border-bone-50/15 text-[0.875rem] text-bone-50/80 disabled:opacity-30">
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
