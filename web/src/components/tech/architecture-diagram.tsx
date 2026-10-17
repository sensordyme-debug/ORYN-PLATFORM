"use client";

import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { pipeline } from "@/content/technology";
import { cn } from "@/lib/cn";

const zones = [
  { label: "Aircraft", from: 0, to: 0 },
  { label: "Processing & analysis", from: 1, to: 3 },
  { label: "Review & delivery", from: 4, to: 5 },
];

export function ArchitectureDiagram() {
  const [active, setActive] = useState(0);
  const stage = pipeline[active]!;

  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    let next = i;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = Math.min(pipeline.length - 1, i + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = Math.max(0, i - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = pipeline.length - 1;
    else return;
    e.preventDefault();
    setActive(next);
    document.getElementById(`arch-${pipeline[next]!.id}`)?.focus();
  };

  return (
    <div className="rounded-[4px] border border-bone-50/10 bg-ink-950">
      {/* Zones (desktop) */}
      <div className="hidden grid-cols-6 border-b border-bone-50/10 lg:grid">
        {zones.map((z) => (
          <div
            key={z.label}
            className="t-mono border-r border-bone-50/10 px-5 py-3 text-bone-50/55 last:border-r-0"
            style={{ gridColumn: `${z.from + 1} / ${z.to + 2}` }}
          >
            {z.label}
          </div>
        ))}
      </div>

      <div className="relative">
        {/* Flow line */}
        <div aria-hidden="true" className="pointer-events-none absolute left-0 right-0 top-[62px] hidden h-px bg-bone-50/15 lg:block">
          <span className="absolute top-1/2 block size-1.5 -translate-y-1/2 rounded-full bg-signal shadow-[0_0_12px_2px_rgba(255,106,43,0.6)] [animation:flow_6s_linear_infinite]" />
        </div>
        <div aria-hidden="true" className="pointer-events-none absolute bottom-0 left-[31px] top-0 w-px bg-bone-50/15 lg:hidden" />

        <div role="tablist" aria-label="ORYN architecture stages" className="relative grid lg:grid-cols-6">
          {pipeline.map((s, i) => {
            const isActive = i === active;
            return (
              <button
                key={s.id}
                id={`arch-${s.id}`}
                role="tab"
                aria-selected={isActive}
                aria-controls="arch-panel"
                tabIndex={isActive ? 0 : -1}
                onClick={() => setActive(i)}
                onMouseEnter={() => setActive(i)}
                onKeyDown={(e) => onKeyDown(e, i)}
                className={cn(
                  "group relative flex items-start gap-4 border-bone-50/10 px-5 py-5 text-left transition-colors lg:flex-col lg:gap-0 lg:border-r lg:py-8 lg:last:border-r-0",
                  isActive ? "bg-bone-50/[0.04]" : "hover:bg-bone-50/[0.02]",
                )}
              >
                <span
                  className={cn(
                    "relative z-10 grid size-6 shrink-0 place-items-center rounded-full border bg-ink-950 transition-colors lg:mt-[26px]",
                    isActive ? "border-signal" : "border-bone-50/30",
                  )}
                >
                  <span className={cn("size-2 rounded-full transition-colors", isActive ? "bg-signal" : "bg-bone-50/30")} />
                </span>
                <span className="lg:mt-8">
                  <span className="t-mono block text-bone-50/55">{s.index}</span>
                  <span className={cn("mt-1 block text-[1.0625rem] font-medium leading-tight tracking-[-0.015em] transition-colors", isActive ? "text-bone-50" : "text-bone-50/70")}>
                    {s.name}
                  </span>
                  <span className="t-small mt-1 block text-bone-50/60">{s.short}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div id="arch-panel" role="tabpanel" aria-labelledby={`arch-${stage.id}`} className="border-t border-bone-50/10">
        <AnimatePresence mode="wait">
          <motion.div
            key={stage.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.3 }}
            className="grid gap-8 p-5 md:p-8 lg:grid-cols-12"
          >
            <div className="lg:col-span-5">
              <div className="flex items-center gap-3">
                <span className="t-mono text-bone-50/55">Stage {stage.index}</span>
                <span className="t-mono rounded-[2px] border border-bone-50/15 px-1.5 py-0.5 text-[0.625rem] uppercase tracking-[0.12em] text-bone-50/60">
                  {stage.status}
                </span>
              </div>
              <h3 className="t-h3 mt-4">{stage.name}</h3>
              <p className="t-body mt-4 max-w-lg text-bone-50/65">{stage.body}</p>
            </div>
            <dl className="grid gap-6 sm:grid-cols-3 lg:col-span-6 lg:col-start-7">
              <div>
                <dt className="t-eyebrow text-bone-50/55">Inputs</dt>
                <dd className="mt-3 space-y-1.5">
                  {stage.inputs.map((x) => (
                    <span key={x} className="block text-[0.9375rem] text-bone-50/80">
                      {x}
                    </span>
                  ))}
                </dd>
              </div>
              <div>
                <dt className="t-eyebrow text-bone-50/55">Outputs</dt>
                <dd className="mt-3 space-y-1.5">
                  {stage.outputs.map((x) => (
                    <span key={x} className="block text-[0.9375rem] text-bone-50/80">
                      {x}
                    </span>
                  ))}
                </dd>
              </div>
              <div>
                <dt className="t-eyebrow text-bone-50/55">Runs on</dt>
                <dd className="mt-3 text-[0.9375rem] text-bone-50/80">{stage.runsOn}</dd>
              </div>
            </dl>
          </motion.div>
        </AnimatePresence>
      </div>
      <div className="t-mono flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-bone-50/10 px-5 py-3 text-bone-50/55 md:px-8">
        <span className="flex items-center gap-2">
          <span className="h-px w-6 border-t border-dashed border-bone-50/50" /> Reviewed findings feed model improvement (planned)
        </span>
      </div>
    </div>
  );
}
