"use client";

import { useMemo, useRef, useState } from "react";
import { formatDate } from "@/lib/format";
import { useElementSize } from "@/lib/use-element-size";

/**
 * Vegetation time series with a p10–p90 spread band and, below it on the
 * same time axis, a separate daily precipitation chart (two charts, one
 * y-scale each — never a dual axis). Unusable observations (clouds, partial
 * coverage) are marked on a rail at the foot of the index chart so gaps are
 * explained instead of silently interpolated. Colors were validated for the
 * dark surface (dataviz validator: band, chroma, CVD, contrast all pass).
 */

const NDVI_COLOR = "#6aa046";
const PRECIP_COLOR = "#3f8fc0";
const GRID = "rgba(242,241,237,0.08)";
const AXIS_TEXT = "rgba(242,241,237,0.5)";

export type SeriesPoint = {
  id: string;
  t: number;
  status: "valid" | "unusable";
  mean: number | null;
  p10: number | null;
  p90: number | null;
  validFraction: number | null;
  source: string;
  reason?: string;
};
export type PrecipPoint = { t: number; mm: number; kind: string };

const PAD = { l: 34, r: 10, t: 8, b: 18 };

export function SeriesChart({
  points,
  precip,
  title,
  yDomain = [-0.2, 1],
  color = NDVI_COLOR,
  activeId,
  onSelect,
  timeZone,
}: {
  /** Series colour (validated against the precipitation blue on the dark surface). */
  color?: string;
  points: SeriesPoint[];
  precip: PrecipPoint[];
  title: string;
  yDomain?: [number, number];
  activeId?: string | null;
  onSelect?: (id: string) => void;
  timeZone?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(wrap);
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const h1 = 130;
  const h2 = 54;

  const sorted = useMemo(() => [...points].sort((a, b) => a.t - b.t), [points]);
  const valid = sorted.filter((p) => p.status === "valid" && p.mean !== null);
  const [t0, t1] = useMemo(() => {
    const ts = [...sorted.map((p) => p.t), ...precip.map((p) => p.t)];
    if (ts.length === 0) return [0, 90 * 864e5];
    const lo = Math.min(...ts);
    const hi = Math.max(...ts);
    return lo === hi ? [lo - 864e5 * 7, hi + 864e5 * 7] : [lo, hi];
  }, [sorted, precip]);

  const iw = Math.max(0, width - PAD.l - PAD.r);
  const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * iw;
  const [y0, y1] = yDomain;
  const y = (v: number) => PAD.t + (1 - (v - y0) / (y1 - y0)) * (h1 - PAD.t - PAD.b);
  const pMax = Math.max(5, ...precip.map((p) => p.mm));
  const yp = (mm: number) => 4 + (1 - mm / pMax) * (h2 - 4 - 14);

  const line = valid.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.mean!).toFixed(1)}`).join("");
  const band = valid.length > 1 && valid.every((p) => p.p10 !== null && p.p90 !== null)
    ? `M${valid.map((p) => `${x(p.t).toFixed(1)},${y(p.p90!).toFixed(1)}`).join("L")}L${[...valid].reverse().map((p) => `${x(p.t).toFixed(1)},${y(p.p10!).toFixed(1)}`).join("L")}Z`
    : null;
  const ticks = [y0, 0, 0.25, 0.5, 0.75, y1].filter((v, i, a) => v >= y0 && v <= y1 && a.indexOf(v) === i);
  const months = useMemo(() => {
    const out: number[] = [];
    const d = new Date(t0);
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
    while (d.getTime() <= t1) {
      if (d.getTime() >= t0) out.push(d.getTime());
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
    return out.length > 8 ? out.filter((_, i) => i % Math.ceil(out.length / 8) === 0) : out;
  }, [t0, t1]);

  const nearest = (px: number) => {
    let best: SeriesPoint | null = null;
    let bd = Infinity;
    for (const p of sorted) {
      const d = Math.abs(x(p.t) - px);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  };
  const hovered = hover !== null ? nearest(hover) : null;
  const barW = Math.max(1, Math.min(8, iw / Math.max(1, (t1 - t0) / 864e5) - 1));
  const dayPrecip = hovered ? precip.filter((p) => Math.abs(p.t - hovered.t) < 864e5 / 2) : [];

  return (
    <div ref={wrap} className="relative w-full">
      <div className="mb-1 flex items-baseline justify-between">
        <p className="text-[0.75rem] font-medium text-bone-50/85">{title}</p>
        <button className="text-[0.6875rem] text-bone-50/50 underline-offset-2 hover:underline" onClick={() => setShowTable((s) => !s)}>
          {showTable ? "Show chart" : "Show table"}
        </button>
      </div>
      {showTable ? (
        <div className="max-h-56 overflow-y-auto">
          <table className="w-full text-[0.6875rem]">
            <thead className="text-bone-50/45"><tr><th className="text-left font-normal">Acquired</th><th className="text-right font-normal">Mean</th><th className="text-right font-normal">p10–p90</th><th className="text-right font-normal">Valid</th><th className="text-left font-normal pl-2">Source</th></tr></thead>
            <tbody>
              {[...sorted].reverse().map((p) => (
                <tr key={p.id} className="text-bone-50/80">
                  <td>{formatDate(p.t, timeZone)}</td>
                  <td className="text-right tabular-nums">{p.status === "valid" ? p.mean?.toFixed(3) : "unusable"}</td>
                  <td className="text-right tabular-nums">{p.status === "valid" && p.p10 !== null ? `${p.p10.toFixed(2)}–${p.p90?.toFixed(2)}` : "—"}</td>
                  <td className="text-right tabular-nums">{p.validFraction !== null ? `${Math.round(p.validFraction * 100)}%` : "—"}</td>
                  <td className="pl-2 text-bone-50/55">{p.source}{p.reason ? ` — ${p.reason}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : width > 0 ? (
        <svg
          width={width}
          height={h1 + h2}
          role="img"
          aria-label={`${title}: ${valid.length} usable observations, ${sorted.length - valid.length} unusable; daily precipitation below.`}
          onPointerMove={(e) => setHover(e.clientX - e.currentTarget.getBoundingClientRect().left)}
          onPointerLeave={() => setHover(null)}
          onClick={() => hovered && onSelect?.(hovered.id)}
          className="cursor-crosshair select-none"
        >
          {ticks.map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={width - PAD.r} y1={y(v)} y2={y(v)} stroke={GRID} strokeWidth={1} />
              <text x={PAD.l - 6} y={y(v) + 3} textAnchor="end" fontSize={9} fill={AXIS_TEXT} className="tabular-nums">{v.toFixed(2).replace(/\.00$/, "")}</text>
            </g>
          ))}
          {band ? <path d={band} fill={color} fillOpacity={0.12} /> : null}
          {line ? <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" /> : null}
          {valid.map((p) => (
            <circle key={p.id} cx={x(p.t)} cy={y(p.mean!)} r={p.id === activeId ? 5.5 : 4} fill={color} stroke="#0f1112" strokeWidth={2} />
          ))}
          {/* Unusable observations: hollow marks on the foot rail. */}
          {sorted.filter((p) => p.status === "unusable").map((p) => (
            <circle key={p.id} cx={x(p.t)} cy={h1 - PAD.b + 2} r={3.5} fill="none" stroke="rgba(242,241,237,0.45)" strokeWidth={1.5} />
          ))}
          {/* Precipitation chart (own axis) */}
          <g transform={`translate(0, ${h1})`}>
            <line x1={PAD.l} x2={width - PAD.r} y1={yp(0)} y2={yp(0)} stroke={GRID} strokeWidth={1} />
            <text x={PAD.l - 6} y={yp(pMax) + 3} textAnchor="end" fontSize={9} fill={AXIS_TEXT}>{Math.round(pMax)}mm</text>
            {precip.map((p) => {
              const top = yp(p.mm);
              const hh = yp(0) - top;
              return hh > 0 ? <rect key={`${p.t}-${p.kind}`} x={x(p.t) - barW / 2} y={top} width={barW} height={hh} rx={Math.min(2, barW / 2)} fill={PRECIP_COLOR} fillOpacity={p.kind === "forecast" ? 0.45 : 1} /> : null;
            })}
            {months.map((m) => (
              <text key={m} x={x(m)} y={h2 - 2} fontSize={9} fill={AXIS_TEXT} textAnchor="middle">
                {new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(m)}
              </text>
            ))}
          </g>
          {hovered ? <line x1={x(hovered.t)} x2={x(hovered.t)} y1={PAD.t} y2={h1 + h2 - 14} stroke="rgba(242,241,237,0.35)" strokeWidth={1} /> : null}
        </svg>
      ) : (
        <div style={{ height: h1 + h2 }} />
      )}
      {!showTable && hovered ? (
        <div
          className="pointer-events-none absolute top-6 z-10 min-w-[11rem] rounded-[3px] border border-bone-50/15 bg-ink-950/95 px-2.5 py-2 text-[0.6875rem] shadow-xl"
          style={{ left: Math.min(Math.max(0, x(hovered.t) + 10), Math.max(0, width - 190)) }}
        >
          <p className="text-bone-50/55">{formatDate(hovered.t, timeZone)} · {hovered.source}</p>
          {hovered.status === "valid" ? (
            <>
              <p className="mt-1 flex items-center gap-2"><span className="inline-block h-0.5 w-3" style={{ background: color }} /><span className="text-[0.8125rem] font-medium tabular-nums text-bone-50">{hovered.mean?.toFixed(3)}</span><span className="text-bone-50/55">mean</span></p>
              {hovered.p10 !== null ? <p className="text-bone-50/60 tabular-nums">p10–p90 {hovered.p10.toFixed(2)}–{hovered.p90?.toFixed(2)}</p> : null}
              {hovered.validFraction !== null ? <p className="text-bone-50/60">{Math.round(hovered.validFraction * 100)}% of area cloud-free</p> : null}
            </>
          ) : (
            <p className="mt-1 text-bone-50/75">Unusable: {hovered.reason ?? "insufficient clear pixels"}</p>
          )}
          {dayPrecip.map((p) => (
            <p key={p.kind} className="mt-1 flex items-center gap-2 text-bone-50/75"><span className="inline-block h-0.5 w-3" style={{ background: PRECIP_COLOR }} /><span className="tabular-nums text-bone-50">{p.mm.toFixed(1)} mm</span> {p.kind.replace("_", " ")}</p>
          ))}
          {onSelect ? <p className="mt-1 text-bone-50/40">Click to show on map</p> : null}
        </div>
      ) : null}
    </div>
  );
}
