"use client";

import { useState } from "react";
import { BeforeAfter } from "@/components/viz/before-after";
import mead2019 from "@/assets/intel/mead-2019.jpg";
import mead2022 from "@/assets/intel/mead-2022.jpg";
import meadChange from "@/assets/intel/mead-change.jpg";
import { cn } from "@/lib/cn";

// Computed from the two HLS scenes (see scripts/README.md). Approximate.
const stats = { water2019: 102.5, water2022: 87.3, lost: 14.3, pctLost: 13.9 };

export function ChangeDetection() {
  const [view, setView] = useState<"change" | "raw">("change");
  return (
    <div className="grid gap-6 lg:grid-cols-12 lg:gap-8">
      <div className="lg:col-span-8">
        <div className="mb-3 flex gap-1" role="radiogroup" aria-label="Comparison view">
          {(
            [
              ["change", "Change map"],
              ["raw", "Raw imagery"],
            ] as const
          ).map(([v, l]) => (
            <button
              key={v}
              role="radio"
              aria-checked={view === v}
              onClick={() => setView(v)}
              className={cn(
                "rounded-[2px] border px-3 py-1.5 text-[0.8125rem] transition-colors",
                view === v ? "border-bone-50/40 bg-bone-50/10 text-bone-50" : "border-bone-50/10 text-bone-50/55 hover:text-bone-50",
              )}
            >
              {l}
            </button>
          ))}
        </div>
        <BeforeAfter
          key={view}
          before={mead2019}
          after={view === "change" ? meadChange : mead2022}
          alt="Satellite view of Lake Mead's Boulder Basin in July 2019"
          beforeLabel="15 Jul 2019"
          afterLabel={view === "change" ? "Change since 2019" : "19 Jul 2022"}
          className="aspect-[1200/989] w-full rounded-[3px]"
        />
        <p className="t-mono mt-3 text-[0.6875rem] text-bone-50/60">
          NASA HLS (Sentinel-2) surface reflectance via NASA GIBS · Lake Mead, Nevada–Arizona · 30 m resolution
        </p>
      </div>
      <div className="lg:col-span-4">
        <div className="border-t border-bone-50/15 pt-5">
          <p className="t-eyebrow text-bone-50/50">Temporal change detection</p>
          <h3 className="t-h3 mt-3">What changed — and by how much.</h3>
          <p className="t-body mt-3 text-bone-50/65">
            Two captures of the same place, aligned and segmented, reveal where conditions have changed. Here, a simple water mask applied to each date shows shoreline retreat across three summers.
          </p>
        </div>
        <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-[3px] border border-bone-50/10 bg-bone-50/10">
          {(
            [
              ["Water · 2019", `${stats.water2019} km²`],
              ["Water · 2022", `${stats.water2022} km²`],
              ["Exposed since 2019", `${stats.lost} km²`],
              ["Relative change", `−${stats.pctLost}%`],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="bg-ink-950 p-4">
              <dt className="t-mono text-bone-50/60">{k}</dt>
              <dd className="mt-1 text-[1.125rem] font-medium tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        <ul className="mt-6 space-y-2.5">
          <li className="flex items-center gap-3 text-[0.875rem] text-bone-50/80">
            <span className="size-2.5 rounded-[2px] bg-data-water" /> Water in both years
          </li>
          <li className="flex items-center gap-3 text-[0.875rem] text-bone-50/80">
            <span className="size-2.5 rounded-[2px] bg-data-amber" /> Water in 2019, exposed in 2022
          </li>
        </ul>
        <p className="t-mono mt-6 text-[0.6875rem] leading-relaxed text-bone-50/55">
          Areas are approximate, computed within this frame only from RGB thresholds on public satellite data. Shown to illustrate the technique; ORYN is designed for higher-resolution aerial capture.
        </p>
      </div>
    </div>
  );
}
