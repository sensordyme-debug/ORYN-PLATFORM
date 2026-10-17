"use client";

import Image from "next/image";
import { AnimatePresence, motion, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { media } from "@/content/media";
import { cn } from "@/lib/cn";

const STEP_MS = 6500;

const steps = [
  {
    id: "request",
    n: "01",
    title: "Request",
    body: "You tell us what you need to know — a field, a site, a stretch of coastline — and how often.",
    image: media.stepRequest,
  },
  {
    id: "deploy",
    n: "02",
    title: "Deploy",
    body: "ORYN plans and conducts an authorized mission. No pilots, hardware, or software on your side.",
    image: media.stepDeploy,
  },
  {
    id: "analyze",
    n: "03",
    title: "Analyze",
    body: "SensorDyme processes the imagery, and our team reviews every finding before it reaches you.",
    image: media.stepAnalyze,
  },
  {
    id: "deliver",
    n: "04",
    title: "Deliver",
    body: "You receive clear findings, maps, and reports in ORYN Portal — written in plain language.",
    image: media.stepDeliver,
  },
] as const;

export function ManagedSteps() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const [cycle, setCycle] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: "-20% 0px -20% 0px" });
  const reduce = useReducedMotion();
  const running = inView && !paused && !reduce;

  useEffect(() => {
    if (!running) return;
    const t = window.setTimeout(() => {
      setActive((a) => (a + 1) % steps.length);
      setCycle((c) => c + 1);
    }, STEP_MS);
    return () => window.clearTimeout(t);
  }, [running, active, cycle]);

  const select = (i: number) => {
    setActive(i);
    setCycle((c) => c + 1);
  };

  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    let next = i;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = (i + 1) % steps.length;
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = (i - 1 + steps.length) % steps.length;
    else return;
    e.preventDefault();
    select(next);
    document.getElementById(`step-tab-${steps[next]!.id}`)?.focus();
  };

  const step = steps[active]!;

  return (
    <div
      ref={ref}
      className="grid gap-10 lg:grid-cols-12 lg:gap-8"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <div className="lg:col-span-5">
        <div role="tablist" aria-orientation="vertical" aria-label="How ORYN works" className="relative">
          <span aria-hidden="true" className="absolute bottom-6 left-[15px] top-6 w-px bg-ink-900/12" />
          <motion.span
            aria-hidden="true"
            className="absolute bottom-6 left-[15px] top-6 w-px origin-top bg-ink-900"
            initial={false}
            animate={{ scaleY: active / (steps.length - 1) }}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          />
          {steps.map((s, i) => {
            const isActive = i === active;
            return (
              <button
                key={s.id}
                id={`step-tab-${s.id}`}
                role="tab"
                aria-selected={isActive}
                aria-controls="step-panel"
                tabIndex={isActive ? 0 : -1}
                onClick={() => select(i)}
                onKeyDown={(e) => onKeyDown(e, i)}
                className="group relative flex w-full gap-6 py-5 text-left"
              >
                <span
                  className={cn(
                    "relative z-10 mt-1 grid size-[31px] shrink-0 place-items-center rounded-full border text-[0.6875rem] font-medium tabular-nums transition-colors duration-500",
                    isActive || i < active ? "border-ink-900 bg-ink-900 text-bone-50" : "border-ink-900/20 bg-bone-100 text-ink-900/60",
                  )}
                >
                  {s.n}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block text-[1.75rem] font-medium leading-none tracking-[-0.035em] transition-colors duration-500 md:text-[2.25rem]",
                      isActive ? "text-ink-900" : "text-ink-900/60 group-hover:text-ink-900/60",
                    )}
                  >
                    {s.title}
                  </span>
                  <span className={cn("grid transition-[grid-template-rows] duration-500 ease-out", isActive ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
                    <span className="overflow-hidden">
                      <span className="t-body block max-w-sm pt-3 text-ink-900/65">{s.body}</span>
                      <span className="mt-4 block h-px w-full max-w-sm overflow-hidden bg-ink-900/10">
                        {isActive ? (
                          <motion.span
                            key={`${active}-${cycle}-${running}`}
                            className="block h-full origin-left bg-ink-900/60"
                            initial={{ scaleX: 0 }}
                            animate={{ scaleX: running ? 1 : 0 }}
                            transition={{ duration: running ? STEP_MS / 1000 : 0.2, ease: "linear" }}
                          />
                        ) : null}
                      </span>
                    </span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="lg:col-span-7" id="step-panel" role="tabpanel" aria-labelledby={`step-tab-${step.id}`}>
        <div className="relative aspect-[4/3] overflow-hidden rounded-[3px] bg-ink-900">
          <AnimatePresence initial={false}>
            <motion.div
              key={step.id}
              className="absolute inset-0"
              initial={{ opacity: 0, scale: 1.04 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.1, ease: [0.16, 1, 0.3, 1] }}
            >
              <Image src={step.image.src} alt={step.image.alt} fill sizes="(min-width: 1024px) 55vw, 100vw" placeholder="blur" className="object-cover" />
              <div className="absolute inset-0 bg-gradient-to-t from-ink-950/60 via-transparent to-transparent" />
            </motion.div>
          </AnimatePresence>
          <StepOverlay id={step.id} />
          <div className="absolute bottom-0 left-0 p-5">
            <span className="t-mono text-bone-50/70">
              Step {step.n} / 04 — {step.title}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function StepOverlay({ id }: { id: (typeof steps)[number]["id"] }) {
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={id}
        className="pointer-events-none absolute inset-0"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.6, delay: 0.2 }}
      >
        {id === "request" ? (
          <div className="absolute right-4 top-4 w-[min(280px,70%)] rounded-[6px] bg-paper p-4 text-ink-900 shadow-2xl md:right-6 md:top-6">
            <p className="t-mono text-ink-900/60">New request</p>
            <p className="mt-1.5 text-[0.9375rem] font-medium">Field survey · North Block</p>
            <div className="mt-3 space-y-1.5 text-[0.8125rem] text-ink-900/65">
              <div className="flex justify-between">
                <span>Frequency</span>
                <span className="text-ink-900">Every 2 weeks</span>
              </div>
              <div className="flex justify-between">
                <span>Goal</span>
                <span className="text-ink-900">Crop health</span>
              </div>
            </div>
            <div className="mt-3 rounded-[4px] bg-ink-900 py-2 text-center text-[0.8125rem] font-medium text-bone-50">Submit request</div>
          </div>
        ) : null}
        {id === "deploy" ? (
          <svg viewBox="0 0 400 300" preserveAspectRatio="none" className="absolute inset-0 size-full" aria-hidden="true">
            <motion.polyline
              points="60,70 340,70 340,110 60,110 60,150 340,150 340,190 60,190 60,230 340,230"
              fill="none"
              stroke="#f2f1ed"
              strokeWidth="1.2"
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 2.4, ease: "easeInOut" }}
            />
            <rect x="52" y="62" width="296" height="176" fill="none" stroke="#ff6a2b" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
          </svg>
        ) : null}
        {id === "analyze" ? (
          <div className="absolute inset-0">
            {[
              [14, 18, 24, 30],
              [52, 24, 20, 26],
              [30, 56, 26, 28],
              [64, 58, 18, 24],
            ].map(([l, t, w, h], i) => (
              <motion.div
                key={i}
                className="absolute border border-bone-50"
                style={{ left: `${l}%`, top: `${t}%`, width: `${w}%`, height: `${h}%` }}
                initial={{ opacity: 0, scale: 1.1 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.5, delay: 0.3 + i * 0.15 }}
              >
                <span className="t-mono absolute -top-5 left-0 whitespace-nowrap bg-bone-50 px-1 text-[0.5625rem] text-ink-950">
                  region_{String(i + 1).padStart(2, "0")}
                </span>
              </motion.div>
            ))}
          </div>
        ) : null}
        {id === "deliver" ? (
          <div className="absolute right-4 top-4 w-[min(290px,72%)] rounded-[6px] bg-paper p-4 text-ink-900 shadow-2xl md:right-6 md:top-6">
            <p className="t-mono text-ink-900/60">ORYN Portal</p>
            <p className="mt-1.5 text-[0.9375rem] font-medium">1 area needs your attention</p>
            <p className="mt-1 text-[0.8125rem] text-ink-900/60">East circle — patchy growth in the south-west half.</p>
            <div className="mt-3 flex gap-2">
              <span className="flex-1 rounded-[4px] border border-ink-900/15 py-2 text-center text-[0.8125rem]">View map</span>
              <span className="flex-1 rounded-[4px] bg-ink-900 py-2 text-center text-[0.8125rem] font-medium text-bone-50">Report</span>
            </div>
          </div>
        ) : null}
      </motion.div>
    </AnimatePresence>
  );
}
