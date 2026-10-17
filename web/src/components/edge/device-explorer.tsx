"use client";

import Image from "next/image";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { edgeParts, edgeViews, type EdgeView } from "@/content/sensordyme";
import { cn } from "@/lib/cn";

/**
 * SensorDyme Edge — product views rendered from the prototype's 3D model
 * (SensorDyme demo), with an exploded view whose parts can be inspected.
 */
export function DeviceExplorer({ initial = "assembled" }: { initial?: EdgeView["id"] }) {
  const [viewId, setViewId] = useState<EdgeView["id"]>(initial);
  const [partId, setPartId] = useState<string | null>(null);
  const view = edgeViews.find((v) => v.id === viewId) ?? edgeViews[0]!;
  const exploded = view.id === "exploded";
  const part = exploded ? edgeParts.find((p) => p.id === partId) ?? null : null;

  const choosePart = (id: string) => {
    setViewId("exploded");
    setPartId((cur) => (cur === id && exploded ? null : id));
  };

  return (
    <div className="grid gap-8 lg:grid-cols-12 lg:items-start [&>*]:min-w-0">
      <div className="lg:col-span-8">
        <div className="relative aspect-[3/2] overflow-hidden rounded-[3px] border border-bone-50/[0.08] bg-[radial-gradient(ellipse_at_50%_42%,#2a2e31_0%,#15181a_45%,#090a0b_80%)]">
          <div aria-hidden="true" className="tech-grid absolute inset-0 text-bone-50 opacity-30 [mask-image:radial-gradient(ellipse_at_50%_50%,black,transparent_75%)]" />
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={view.id}
              className="absolute inset-0"
              initial={{ opacity: 0, scale: 0.985 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className={cn("absolute", exploded ? "inset-x-[3%] top-1/2 aspect-[3/2] -translate-y-1/2" : "inset-6 md:inset-12")}>
                <Image src={view.image} alt={view.alt} fill sizes="(min-width: 1024px) 62vw, 100vw" className="object-contain" />
              </div>
            </motion.div>
          </AnimatePresence>

          {/* Hotspots share the exploded render's exact 3:2 box, so percentages map onto the image. */}
          <div className="pointer-events-none absolute inset-x-[3%] top-1/2 aspect-[3/2] -translate-y-1/2">
          {exploded
            ? edgeParts.map((p) => {
                const on = part?.id === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => choosePart(p.id)}
                    aria-pressed={on}
                    aria-label={`${p.name} — ${p.role}`}
                    className="group pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 p-2"
                    style={{ left: `${p.at[0]}%`, top: `${p.at[1]}%` }}
                  >
                    <span
                      className={cn(
                        "t-mono grid size-6 place-items-center rounded-full border text-[0.625rem] backdrop-blur-sm transition-colors md:size-7",
                        on ? "border-signal bg-signal text-ink-950" : "border-bone-50/50 bg-ink-950/70 text-bone-50 group-hover:border-bone-50",
                      )}
                    >
                      {p.n.slice(1)}
                    </span>
                  </button>
                );
              })
            : null}
          </div>

          <div className="t-mono pointer-events-none absolute left-4 top-4 flex items-center gap-2 text-[0.6875rem] text-bone-50/60 md:left-5 md:top-5">
            <span className="size-1.5 rounded-full bg-data-water" /> SensorDyme Edge · Prototype
          </div>
        </div>

        <div role="tablist" aria-label="Device views" className="no-scrollbar -mx-[var(--gutter)] mt-3 flex gap-1 overflow-x-auto px-[var(--gutter)] md:mx-0 md:px-0">
          {edgeViews.map((v, i) => (
            <button
              key={v.id}
              role="tab"
              aria-selected={v.id === view.id}
              onClick={() => setViewId(v.id)}
              className={cn(
                "relative shrink-0 px-4 py-3 text-[0.9375rem] tracking-[-0.01em] transition-colors first:pl-0",
                v.id === view.id ? "text-bone-50" : "text-bone-50/60 hover:text-bone-50/80",
              )}
            >
              {v.label}
              {v.id === view.id ? (
                <motion.span layoutId="edge-view-tab" className={cn("absolute bottom-0 right-4 h-px bg-bone-50", i === 0 ? "left-0" : "left-4")} transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }} />
              ) : null}
            </button>
          ))}
        </div>
        <p className="t-mono mt-2 text-[0.6875rem] text-bone-50/60">
          Renders of the current prototype industrial design, generated from the 3D model in the SensorDyme demo. Components are third-party parts; enclosure design is ORYN&apos;s.
        </p>
      </div>

      <div className="lg:col-span-4">
        <AnimatePresence mode="wait">
          <motion.div
            key={part?.id ?? view.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.3 }}
            className="border-t border-bone-50/15 pt-5"
          >
            {part ? (
              <>
                <p className="t-eyebrow text-bone-50/50">
                  {part.n} · {part.role}
                </p>
                <h3 className="t-h3 mt-3">{part.name}</h3>
                <p className="t-body mt-3 text-bone-50/65">{part.body}</p>
                <p className="t-mono mt-4 text-bone-50/50">{part.source ?? "Third-party component"}</p>
              </>
            ) : (
              <>
                <p className="t-eyebrow text-bone-50/50">{view.label} view</p>
                <p className="t-h4 mt-3 text-bone-50/85">{view.caption}</p>
              </>
            )}
          </motion.div>
        </AnimatePresence>

        <ul className="mt-6" aria-label="Components">
          {edgeParts.map((p) => {
            const on = part?.id === p.id;
            return (
              <li key={p.id} className="border-t border-bone-50/10 last:border-b">
                <button type="button" onClick={() => choosePart(p.id)} aria-pressed={on} className="flex w-full items-baseline gap-4 py-2.5 text-left">
                  <span className={cn("t-mono transition-colors", on ? "text-signal" : "text-bone-50/50")}>{p.n}</span>
                  <span className={cn("text-[0.9375rem] transition-colors", on ? "text-bone-50" : "text-bone-50/70 hover:text-bone-50")}>{p.name}</span>
                  <span className="t-mono ml-auto hidden text-bone-50/45 sm:inline">{p.role}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
