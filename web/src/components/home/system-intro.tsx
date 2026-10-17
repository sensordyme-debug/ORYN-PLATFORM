"use client";

import Image from "next/image";
import { motion, useMotionValueEvent, useReducedMotion, useScroll, useTransform, type MotionValue } from "motion/react";
import { useEffect, useRef, useState } from "react";
import baseImg from "@/assets/usgs/system-base.jpg";
import segImg from "@/assets/usgs/system-seg.webp";
import { DroneGlyph } from "@/components/viz/drone-glyph";
import { Eyebrow, MediaNote } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

const steps = [
  {
    n: "01",
    title: "Aircraft",
    product: "SensorDyme Aero",
    body: "Modular aircraft designed to capture consistent, high-quality aerial data across large and complex areas.",
  },
  {
    n: "02",
    title: "Vision",
    product: "SensorDyme",
    body: "Computer vision that turns raw imagery into detections, segmented regions, and measurements on a map.",
  },
  {
    n: "03",
    title: "Platform",
    product: "ORYN Command & Portal",
    body: "Software that organizes missions, routes findings through human review, and delivers answers people can act on.",
  },
];

// Illustrative detections, in source-image pixels (1440 × 1160).
const boxes: { x: number; y: number; w: number; h: number; label: string }[] = [
  { x: 70, y: 47, w: 243, h: 245, label: "pivot_field 0.97" },
  { x: 822, y: 37, w: 270, h: 271, label: "pivot_field 0.94" },
  { x: 322, y: 538, w: 241, h: 240, label: "crop_dense 0.93" },
  { x: 570, y: 538, w: 238, h: 240, label: "ring_pattern 0.81" },
  { x: 1007, y: 775, w: 293, h: 292, label: "pivot_field 0.96" },
];

function useIsDesktop() {
  const [is, setIs] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const on = () => setIs(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return is;
}

export function SystemIntro({ index = "01" }: { index?: string }) {
  const ref = useRef<HTMLElement>(null);
  const isDesktop = useIsDesktop();
  const reduce = useReducedMotion();
  const scrollDriven = isDesktop && !reduce;
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  const [active, setActive] = useState(0);
  const stepFor = (p: number) => (p < 0.3 ? 0 : p < 0.62 ? 1 : 2);

  useMotionValueEvent(scrollYProgress, "change", (p) => {
    if (scrollDriven) setActive(stepFor(p));
  });
  useEffect(() => {
    if (!scrollDriven) return;
    const t = window.setTimeout(() => setActive(stepFor(scrollYProgress.get())), 0);
    return () => window.clearTimeout(t);
  }, [scrollDriven, scrollYProgress]);
  const current = scrollDriven ? active : 2;

  return (
    <section ref={ref} id="system" aria-labelledby="system-title" className="relative bg-ink-900 lg:h-[330vh]">
      <div className="lg:sticky lg:top-0 lg:flex lg:h-screen lg:items-center">
        <div className="shell grid gap-10 py-24 lg:grid-cols-12 lg:gap-8 lg:py-0">
          <div className="flex flex-col justify-center lg:col-span-5 xl:col-span-4">
            <Eyebrow index={index}>The aerial system</Eyebrow>
            <h2 id="system-title" className="t-h2 mt-6 uppercase">
              More than
              <br />a drone.
            </h2>
            <p className="t-lead mt-6 max-w-md text-bone-50/70">An integrated aerial intelligence system.</p>
            <p className="t-body mt-4 max-w-md text-bone-50/55">
              Aero, SensorDyme, and ORYN&apos;s operations software are designed as one system — so aerial observation becomes information you can act on.
            </p>

            <ol className="mt-10 border-t border-bone-50/10">
              {steps.map((s, i) => (
                <li key={s.n} className="border-b border-bone-50/10">
                  <div className={cn("py-4 transition-opacity duration-500", i === current || !scrollDriven ? "opacity-100" : "opacity-50")}>
                    <div className="flex items-baseline gap-4">
                      <span className="t-mono text-bone-50/60">{s.n}</span>
                      <span className="text-[1.0625rem] font-medium tracking-[-0.015em]">{s.title}</span>
                      <span className="t-mono ml-auto text-bone-50/60">{s.product}</span>
                    </div>
                    <div
                      className={cn(
                        "grid transition-[grid-template-rows] duration-500 ease-out",
                        i === current || !scrollDriven ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                      )}
                    >
                      <p className="t-small overflow-hidden pl-9 pt-2 text-bone-50/60">{s.body}</p>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div className="lg:col-span-7 lg:flex lg:items-center xl:col-span-8">
            <Composition progress={scrollYProgress} scrollDriven={scrollDriven} />
          </div>
        </div>
      </div>
    </section>
  );
}

function Composition({ progress, scrollDriven }: { progress: MotionValue<number>; scrollDriven: boolean }) {
  const droneOpacity = useTransform(progress, [0.02, 0.14], [0, 1]);
  const droneX = useTransform(progress, [0, 0.3, 1], ["-18%", "0%", "6%"]);
  const droneY = useTransform(progress, [0, 0.3, 1], ["14%", "0%", "-4%"]);
  const footprint = useTransform(progress, [0.08, 0.3], [0, 1]);
  const segClip = useTransform(progress, [0.3, 0.56], ["inset(0% 100% 0% 0%)", "inset(0% 0% 0% 0%)"]);
  const boxOpacity = useTransform(progress, [0.42, 0.58], [0, 1]);
  const panelOpacity = useTransform(progress, [0.62, 0.78], [0, 1]);
  const panelY = useTransform(progress, [0.62, 0.8], [40, 0]);
  const dim = useTransform(progress, [0.62, 0.8], [0, 0.35]);

  const sd = <T,>(v: T) => (scrollDriven ? v : undefined);

  return (
    <figure className="relative w-full">
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-[3px] bg-ink-850 lg:aspect-auto lg:h-[min(76vh,760px)]">
        <Image src={baseImg} alt="Aerial orthoimagery of irrigated farmland" fill sizes="(min-width: 1024px) 60vw, 100vw" placeholder="blur" className="object-cover" />
        <div className="absolute inset-0 bg-ink-950/20" />

        {/* Vision: segmentation */}
        <motion.div className="absolute inset-0" style={{ clipPath: sd(segClip) }}>
          <Image src={segImg} alt="" fill sizes="(min-width: 1024px) 60vw, 100vw" className="object-cover mix-blend-hard-light" />
        </motion.div>

        {/* Vision: detections */}
        <motion.svg
          viewBox="0 0 1440 1160"
          preserveAspectRatio="xMidYMid slice"
          className="absolute inset-0 size-full"
          style={{ opacity: sd(boxOpacity) }}
          aria-hidden="true"
        >
          {boxes.map((b) => (
            <g key={b.label + b.x}>
              <rect x={b.x} y={b.y} width={b.w} height={b.h} fill="none" stroke="#f2f1ed" strokeWidth="2" vectorEffect="non-scaling-stroke" />
              <rect x={b.x} y={b.y < 60 ? b.y : b.y - 30} width={b.label.length * 13 + 16} height="30" fill="#f2f1ed" />
              <text x={b.x + 8} y={b.y < 60 ? b.y + 21 : b.y - 9} className="font-mono" fontSize="20" fill="#0a0b0c">
                {b.label}
              </text>
            </g>
          ))}
        </motion.svg>

        <motion.div className="pointer-events-none absolute inset-0 bg-ink-950" style={{ opacity: scrollDriven ? dim : 0.15 }} />

        {/* Aircraft */}
        <motion.div
          className="absolute left-[38%] top-[16%] w-[24%]"
          style={{ opacity: sd(droneOpacity), x: sd(droneX), y: sd(droneY) }}
        >
          <motion.div
            className="absolute left-1/2 top-[70%] h-[150%] w-[170%] -translate-x-1/2 border border-dashed border-bone-50/70 bg-bone-50/[0.05]"
            style={{ opacity: sd(footprint), scaleY: sd(footprint), transformOrigin: "50% 0%" }}
          >
            <span className="t-mono absolute -bottom-6 left-0 whitespace-nowrap text-[0.625rem] uppercase tracking-[0.12em] text-bone-50/80">
              Capture footprint
            </span>
          </motion.div>
          <div className="relative drop-shadow-[0_28px_24px_rgba(0,0,0,0.65)]">
            <DroneGlyph />
          </div>
          <span className="t-mono absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-[2px] bg-ink-950/80 px-1.5 py-0.5 text-[0.625rem] uppercase tracking-[0.12em] text-bone-50/80">
            A1 · concept
          </span>
        </motion.div>

        {/* Platform */}
        <motion.div
          className="absolute bottom-3 right-3 w-[min(300px,52%)] rounded-[4px] border border-bone-50/10 bg-ink-950/90 p-3 sm:p-4 shadow-2xl backdrop-blur-md md:bottom-6 md:right-6"
          style={{ opacity: sd(panelOpacity), y: sd(panelY) }}
        >
          <div className="t-mono flex items-center justify-between text-bone-50/60">
            <span>Field summary</span>
            <span>Sample</span>
          </div>
          <p className="mt-2 text-[0.8125rem] font-medium leading-snug sm:text-[0.9375rem]">5 fields analyzed · 1 needs attention</p>
          <div className="mt-3 hidden space-y-1.5 sm:block">
            {[
              ["Vegetation", 82, "var(--color-data-veg)"],
              ["Pattern", 46, "var(--color-data-amber)"],
              ["Reviewed", 100, "var(--color-bone-50)"],
            ].map(([k, v, c]) => (
              <div key={k as string} className="flex items-center gap-3">
                <span className="t-mono w-20 text-bone-50/50">{k}</span>
                <span className="h-1 flex-1 overflow-hidden rounded-full bg-bone-50/10">
                  <span className="block h-full rounded-full" style={{ width: `${v}%`, background: c as string }} />
                </span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-bone-50/10 pt-3">
            <span className="t-mono text-bone-50/60">Report</span>
            <span className="t-mono text-data-veg">Ready</span>
          </div>
        </motion.div>
      </div>
      <figcaption className="mt-3 flex flex-wrap justify-between gap-2">
        <MediaNote>Concept composition · Imagery: USGS orthoimagery (public domain)</MediaNote>
        <MediaNote>Detections and summary are illustrative</MediaNote>
      </figcaption>
    </figure>
  );
}
