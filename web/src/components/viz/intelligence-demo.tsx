"use client";

import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { BeforeAfter } from "@/components/viz/before-after";
import { demos, type Demo, type DemoId } from "@/content/intelligence";
import { cn } from "@/lib/cn";

function Detections({ demo }: { demo: Demo }) {
  if (!demo.boxes?.length) return null;
  return (
    <svg viewBox={`0 0 ${demo.size.w} ${demo.size.h}`} preserveAspectRatio="xMidYMid slice" className="absolute inset-0 size-full" aria-hidden="true">
      {demo.boxes.map((b, i) => {
        const label = `${b.label} ${b.score.toFixed(2)}`;
        const fs = Math.max(14, demo.size.w / 90);
        return (
          <g key={i}>
            <rect x={b.x} y={b.y} width={b.w} height={b.h} fill="rgba(255,106,43,0.08)" stroke="#ff6a2b" strokeWidth="2" vectorEffect="non-scaling-stroke" />
            <rect x={b.x} y={b.y - fs * 1.6} width={label.length * fs * 0.62 + fs * 0.8} height={fs * 1.6} fill="#ff6a2b" />
            <text x={b.x + fs * 0.4} y={b.y - fs * 0.45} fontSize={fs} className="font-mono" fill="#0a0b0c">
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function IntelligenceDemo({ initial = "agriculture", only }: { initial?: DemoId; only?: DemoId[] }) {
  const list = only ? demos.filter((d) => only.includes(d.id)) : demos;
  const [id, setId] = useState<DemoId>(list.some((d) => d.id === initial) ? initial : list[0]!.id);
  const demo = list.find((d) => d.id === id) ?? list[0]!;

  return (
    <div>
      {list.length > 1 ? (
        <div role="tablist" aria-label="Analysis examples" className="no-scrollbar -mx-[var(--gutter)] flex gap-1 overflow-x-auto px-[var(--gutter)] md:mx-0 md:px-0">
          {list.map((d) => (
            <button
              key={d.id}
              role="tab"
              aria-selected={d.id === id}
              aria-controls="intel-panel"
              onClick={() => setId(d.id)}
              className={cn(
                "relative shrink-0 px-4 py-3 text-[0.9375rem] tracking-[-0.01em] transition-colors",
                d.id === id ? "text-bone-50" : "text-bone-50/60 hover:text-bone-50/80",
              )}
            >
              {d.label}
              {d.id === id ? (
                <motion.span layoutId="intel-tab" className="absolute inset-x-4 bottom-0 h-px bg-bone-50" transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }} />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      <div id="intel-panel" role="tabpanel" className="mt-4 grid gap-6 lg:grid-cols-12 lg:gap-8">
        <div className="lg:col-span-8">
          <BeforeAfter
            key={demo.id}
            before={demo.before}
            after={demo.after}
            alt={demo.alt}
            overlay={<Detections demo={demo} />}
            afterLabel={`Analyzed · ${demo.title}`}
            className="aspect-[4/3] w-full rounded-[3px] md:aspect-[16/10]"
          />
          <p className="t-mono mt-3 text-[0.6875rem] text-bone-50/60">
            Illustrative output · {demo.credit}
          </p>
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={demo.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.35 }}
            className="lg:col-span-4"
          >
            <div className="border-t border-bone-50/15 pt-5">
              <p className="t-eyebrow text-bone-50/50">{demo.task}</p>
              <h3 className="t-h3 mt-3">{demo.title}</h3>
              <p className="t-body mt-3 text-bone-50/65">{demo.description}</p>
            </div>

            <dl className="t-mono mt-6 space-y-2 border-t border-bone-50/10 pt-5 text-bone-50/55">
              <div className="flex justify-between gap-4">
                <dt>Method</dt>
                <dd className="text-right text-bone-50/85">{demo.method}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Input</dt>
                <dd className="text-right text-bone-50/85">{demo.input}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Output</dt>
                <dd className="text-right text-bone-50/85">{demo.output}</dd>
              </div>
            </dl>

            <ul className="mt-6 space-y-2.5 border-t border-bone-50/10 pt-5">
              {demo.legend.map((l) => (
                <li key={l.label} className="flex items-center gap-3">
                  <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: l.color }} />
                  <span className="text-[0.875rem] text-bone-50/80">{l.label}</span>
                  {l.value ? <span className="t-mono ml-auto text-bone-50/55">{l.value}</span> : null}
                </li>
              ))}
            </ul>
            <p className="t-mono mt-6 text-[0.6875rem] leading-relaxed text-bone-50/55">{demo.disclaimer}</p>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
