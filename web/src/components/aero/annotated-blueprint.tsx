"use client";

import { useState } from "react";
import { DroneBlueprint, blueprintCallouts, type BlueprintPart } from "@/components/viz/drone-blueprint";
import { a1Modules } from "@/content/aero";
import { cn } from "@/lib/cn";

/** Concept blueprint with a module list that highlights parts on hover/focus. */
export function AnnotatedBlueprint({ detailed = false }: { detailed?: boolean }) {
  const [active, setActive] = useState<BlueprintPart | null>(null);
  const [pinned, setPinned] = useState<BlueprintPart | null>(null);
  const current = active ?? pinned;

  return (
    <div className="grid gap-10 lg:grid-cols-12 lg:items-center">
      <div className="relative lg:col-span-8">
        <div className="tech-grid relative rounded-[3px] border border-bone-50/[0.08] bg-ink-950 p-3 text-bone-50 sm:p-6 md:p-10">
          <DroneBlueprint active={current} />
          <div className="t-mono absolute left-4 top-4 flex items-center gap-2 text-[0.6875rem] text-bone-50/50 md:left-6 md:top-6">
            <span className="size-1.5 rounded-full bg-signal" /> Aero A1 · Concept drawing
          </div>
        </div>
        <p className="t-mono mt-3 text-[0.6875rem] text-bone-50/60">
          Concept illustration of the SensorDyme Aero A1 development platform. Final hardware design, dimensions, and specifications are not yet established.
        </p>
      </div>

      <ul className="lg:col-span-4" onMouseLeave={() => setActive(null)}>
        {blueprintCallouts.map((c) => {
          const mod = a1Modules.find((m) => m.id === c.part);
          const isOn = current === c.part;
          return (
            <li key={c.part} className="border-t border-bone-50/10 last:border-b">
              <button
                onMouseEnter={() => setActive(c.part)}
                onFocus={() => setActive(c.part)}
                onBlur={() => setActive(null)}
                onClick={() => setPinned((p) => (p === c.part ? null : c.part))}
                aria-pressed={pinned === c.part}
                className="w-full py-4 text-left"
              >
                <span className="flex items-baseline gap-4">
                  <span className={cn("t-mono transition-colors", isOn ? "text-signal" : "text-bone-50/55")}>{c.n}</span>
                  <span className={cn("text-[1.0625rem] font-medium tracking-[-0.015em] transition-colors", isOn ? "text-bone-50" : "text-bone-50/75")}>
                    {mod?.name ?? c.label}
                  </span>
                  <span className="t-mono ml-auto hidden text-bone-50/55 sm:inline">{mod?.summary}</span>
                </span>
                {detailed && mod ? (
                  <span className={cn("grid transition-[grid-template-rows] duration-500", isOn ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
                    <span className="t-small overflow-hidden pl-9 pt-2 text-bone-50/60">{mod.detail}</span>
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
