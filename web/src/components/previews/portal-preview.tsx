"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { LogoMark } from "@/components/brand/logo";
import fieldImg from "@/assets/usgs/portal-field.jpg";
import { cn } from "@/lib/cn";

/**
 * SAMPLE DATA — ORYN Portal concept. The aerial image is public-domain USGS
 * orthoimagery; the property, findings, scores and history are illustrative.
 */

type Zone = {
  id: string;
  title: string;
  status: "attention" | "watch";
  summary: string;
  detail: string;
  suggestion: string;
  size: string;
  shape: { kind: "path"; d: string } | { kind: "circle"; cx: number; cy: number; r: number } | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number };
  label: [number, number];
  history: number[];
};

const zones: Zone[] = [
  {
    id: "east",
    title: "East circle",
    status: "attention",
    summary: "Patchy growth in the south-west half",
    detail:
      "About 22 acres of this field are growing less evenly than the rest. The curved pattern follows the irrigation path, which often points to uneven watering.",
    suggestion: "Check the outer sprinkler spans for clogged or worn nozzles.",
    size: "≈ 22 acres",
    shape: {
      kind: "path",
      d: "M805 780C905 790 1030 860 1110 960C1160 1040 1165 1150 1120 1240C1100 1280 1085 1300 1075 1312L805 1312Z",
    },
    label: [960, 1060],
    history: [78, 77, 79, 74, 70, 66],
  },
  {
    id: "center",
    title: "Center circle",
    status: "watch",
    summary: "Faint ring pattern",
    detail:
      "Light rings are visible across the field. Growth is still within the normal range for this property, but the pattern is worth watching.",
    suggestion: "Take a look on your next walk. We'll compare again next inspection.",
    size: "≈ 44 acres",
    shape: { kind: "circle", cx: 540, cy: 752, r: 236 },
    label: [540, 752],
    history: [74, 75, 74, 73, 73, 72],
  },
  {
    id: "ditch",
    title: "Drainage area",
    status: "watch",
    summary: "Wet ground near the ditch",
    detail: "Standing water or saturated soil was detected along the drainage line south of the east circle.",
    suggestion: "Avoid heavy equipment in this area until it dries.",
    size: "≈ 2 acres",
    shape: { kind: "ellipse", cx: 1010, cy: 1392, rx: 120, ry: 46 },
    label: [1010, 1392],
    history: [80, 80, 79, 78, 76, 75],
  },
];

const statusStyle = {
  attention: { color: "#d4531c", bg: "bg-[#d4531c]", soft: "bg-[#d4531c]/10 text-[#b5420f]", label: "Needs attention" },
  watch: { color: "#b8860b", bg: "bg-[#b8860b]", soft: "bg-[#b8860b]/12 text-[#8a6408]", label: "Worth watching" },
} as const;

export function PortalPreview() {
  const [selected, setSelected] = useState<string>("east");
  const [toast, setToast] = useState<string | null>(null);
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestWhen, setRequestWhen] = useState<string>("This week");
  const [requested, setRequested] = useState(false);
  const zone = zones.find((z) => z.id === selected)!;

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3800);
    return () => window.clearTimeout(t);
  }, [toast]);

  return (
    <div className="relative overflow-hidden rounded-[8px] border border-ink-900/10 bg-paper text-ink-900 shadow-[0_40px_100px_-50px_rgba(10,11,12,0.45)]">
      {/* App header */}
      <div className="flex h-14 items-center justify-between gap-4 border-b border-ink-900/[0.08] bg-white px-4 md:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <LogoMark className="h-5 w-auto shrink-0 text-ink-900" aria-hidden="true" />
          <span className="text-[0.9375rem] font-medium">Portal</span>
          <span className="hidden h-5 w-px bg-ink-900/10 sm:block" />
          <span className="hidden truncate text-[0.875rem] text-ink-900/60 sm:block">North Block · Sample property</span>
        </div>
        <span className="t-mono shrink-0 rounded-full bg-ink-900/[0.06] px-2.5 py-1 text-[0.625rem] uppercase tracking-[0.12em] text-ink-900/60">
          Concept preview · Sample data
        </span>
      </div>

      <div className="p-4 md:p-6">
        {/* Greeting & summary */}
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div>
            <p className="text-[0.875rem] text-ink-900/65">Latest inspection · Sample day 12</p>
            <h3 className="mt-1 text-[1.5rem] font-medium tracking-[-0.025em] md:text-[1.75rem]">
              1 area needs your attention.
            </h3>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setToast("This is a preview. In ORYN Portal, reports download as a PDF with maps and findings.")}
              className="inline-flex h-10 flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-[6px] border border-ink-900/15 bg-white px-3 text-[0.8125rem] font-medium transition-colors hover:border-ink-900/40 sm:flex-none sm:px-3.5 sm:text-[0.875rem]"
            >
              <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                <path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M3 13h10" />
              </svg>
              Download report
            </button>
            <button
              onClick={() => {
                setRequestOpen((o) => !o);
                setRequested(false);
              }}
              aria-expanded={requestOpen}
              className="inline-flex h-10 flex-1 items-center justify-center whitespace-nowrap rounded-[6px] bg-ink-900 px-3 text-[0.8125rem] font-medium text-bone-50 transition-colors hover:bg-ink-700 sm:flex-none sm:px-3.5 sm:text-[0.875rem]"
            >
              Request inspection
            </button>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {requestOpen ? (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              className="overflow-hidden"
            >
              <div className="mt-4 rounded-[6px] border border-ink-900/10 bg-white p-4">
                {requested ? (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-[0.9375rem]">
                      <span className="font-medium">Preview only:</span> in ORYN Portal, this would schedule an inspection for {requestWhen.toLowerCase()}.
                    </p>
                    <Link href="/contact?intent=demo" className="text-[0.875rem] font-medium underline underline-offset-4">
                      Talk to the ORYN team
                    </Link>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-[0.9375rem] font-medium">When should we fly?</p>
                      <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Inspection timing">
                        {["This week", "Next week", "Before harvest"].map((w) => (
                          <button
                            key={w}
                            role="radio"
                            aria-checked={requestWhen === w}
                            onClick={() => setRequestWhen(w)}
                            className={cn(
                              "rounded-full border px-3 py-1.5 text-[0.8125rem] transition-colors",
                              requestWhen === w ? "border-ink-900 bg-ink-900 text-bone-50" : "border-ink-900/15 hover:border-ink-900/40",
                            )}
                          >
                            {w}
                          </button>
                        ))}
                      </div>
                    </div>
                    <button
                      onClick={() => setRequested(true)}
                      className="h-10 rounded-[6px] bg-ink-900 px-4 text-[0.875rem] font-medium text-bone-50 hover:bg-ink-700"
                    >
                      Send request
                    </button>
                  </div>
                )}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          {/* Field map */}
          <div className="overflow-hidden rounded-[6px] border border-ink-900/10 bg-white">
            <div className="flex items-center justify-between border-b border-ink-900/[0.06] px-4 py-3">
              <p className="text-[0.875rem] font-medium">Field map</p>
              <div className="flex items-center gap-3 text-[0.75rem] text-ink-900/60">
                <span className="flex items-center gap-1.5">
                  <span className={cn("size-2 rounded-full", statusStyle.attention.bg)} /> Needs attention
                </span>
                <span className="flex items-center gap-1.5">
                  <span className={cn("size-2 rounded-full", statusStyle.watch.bg)} /> Worth watching
                </span>
              </div>
            </div>
            <div className="relative aspect-square">
              <Image
                src={fieldImg}
                alt="Aerial image of the sample property's fields"
                fill
                sizes="(min-width: 1024px) 40vw, 100vw"
                placeholder="blur"
                className="object-cover"
              />
              <div className="absolute inset-0 bg-white/10" />
              <svg viewBox="0 0 1600 1600" className="absolute inset-0 size-full" aria-hidden="true">
                {zones.map((z) => {
                  const st = statusStyle[z.status];
                  const sel = z.id === selected;
                  const common = {
                    fill: st.color,
                    fillOpacity: sel ? 0.3 : 0.12,
                    stroke: st.color,
                    strokeWidth: sel ? 6 : 3,
                    strokeDasharray: sel ? undefined : "14 10",
                    className: "cursor-pointer transition-all duration-300",
                    onClick: () => setSelected(z.id),
                  };
                  if (z.shape.kind === "circle") return <circle key={z.id} cx={z.shape.cx} cy={z.shape.cy} r={z.shape.r} {...common} />;
                  if (z.shape.kind === "ellipse")
                    return <ellipse key={z.id} cx={z.shape.cx} cy={z.shape.cy} rx={z.shape.rx} ry={z.shape.ry} {...common} />;
                  return <path key={z.id} d={z.shape.d} {...common} />;
                })}
              </svg>
              {zones.map((z) => (
                <button
                  key={z.id}
                  onClick={() => setSelected(z.id)}
                  className={cn(
                    "absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full px-2.5 py-1 text-[0.75rem] font-medium shadow-sm transition-transform",
                    z.id === selected ? "scale-105 bg-ink-900 text-bone-50" : "bg-white/90 text-ink-900 hover:scale-105",
                  )}
                  style={{ left: `${(z.label[0] / 1600) * 100}%`, top: `${(z.label[1] / 1600) * 100}%` }}
                >
                  {z.title}
                </button>
              ))}
            </div>
          </div>

          {/* Areas & detail */}
          <div className="flex min-w-0 flex-col gap-4">
            <div className="rounded-[6px] border border-ink-900/10 bg-white">
              <p className="border-b border-ink-900/[0.06] px-4 py-3 text-[0.875rem] font-medium">Areas requiring attention</p>
              <ul className="divide-y divide-ink-900/[0.06]">
                {zones.map((z) => {
                  const st = statusStyle[z.status];
                  return (
                    <li key={z.id}>
                      <button
                        onClick={() => setSelected(z.id)}
                        aria-pressed={z.id === selected}
                        className={cn(
                          "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors",
                          z.id === selected ? "bg-ink-900/[0.035]" : "hover:bg-ink-900/[0.02]",
                        )}
                      >
                        <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", st.bg)} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[0.9375rem] font-medium">{z.title}</span>
                          <span className="block text-[0.875rem] text-ink-900/60">{z.summary}</span>
                        </span>
                        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium", st.soft)}>{st.label}</span>
                      </button>
                    </li>
                  );
                })}
                <li className="px-4 py-3 text-[0.875rem] text-ink-900/60">Other fields: no issues found.</li>
              </ul>
            </div>

            <AnimatePresence mode="wait">
              <motion.div
                key={zone.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.3 }}
                className="rounded-[6px] border border-ink-900/10 bg-white p-4"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-[1rem] font-medium">{zone.title}</p>
                  <p className="text-[0.8125rem] text-ink-900/60">{zone.size}</p>
                </div>
                <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-900/75">{zone.detail}</p>
                <div className="mt-3 rounded-[4px] bg-ink-900/[0.04] p-3">
                  <p className="text-[0.75rem] font-medium uppercase tracking-[0.08em] text-ink-900/60">What we suggest</p>
                  <p className="mt-1 text-[0.9375rem]">{zone.suggestion}</p>
                </div>
                <History values={zone.history} color={statusStyle[zone.status].color} />
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {toast ? (
          <motion.div
            role="status"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            className="absolute inset-x-4 bottom-4 mx-auto max-w-md rounded-[6px] bg-ink-900 px-4 py-3 text-[0.875rem] text-bone-50 shadow-xl"
          >
            {toast}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function History({ values, color }: { values: number[]; color: string }) {
  const W = 300;
  const H = 70;
  const min = 60;
  const max = 85;
  const x = (i: number) => (i / (values.length - 1)) * (W - 16) + 8;
  const y = (v: number) => H - 10 - ((v - min) / (max - min)) * (H - 20);
  const d = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const first = values[0] ?? 0;
  const last = values[values.length - 1] ?? 0;
  const trend = last - first;
  return (
    <div className="mt-4">
      <div className="flex items-baseline justify-between">
        <p className="text-[0.8125rem] font-medium">Growth over the last 6 inspections</p>
        <p className="text-[0.8125rem] text-ink-900/65">{trend < -3 ? "Getting worse" : trend > 3 ? "Improving" : "Steady"}</p>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 h-16 w-full" aria-hidden="true">
        <line x1="0" x2={W} y1={H - 10} y2={H - 10} stroke="rgba(10,11,12,0.1)" />
        <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {values.map((v, i) => (
          <circle key={i} cx={x(i)} cy={y(v)} r={i === values.length - 1 ? 3.5 : 2.2} fill={i === values.length - 1 ? color : "white"} stroke={color} strokeWidth="1.5" />
        ))}
      </svg>
      <div className="mt-1 flex justify-between text-[0.6875rem] text-ink-900/60">
        <span>6 inspections ago</span>
        <span>Latest</span>
      </div>
    </div>
  );
}
