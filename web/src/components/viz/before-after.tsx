"use client";

import Image, { type StaticImageData } from "next/image";
import { animate, useInView, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

type Props = {
  before: StaticImageData;
  after: StaticImageData;
  alt: string;
  /** SVG/HTML overlay aligned to the image, rendered on the analyzed side. */
  overlay?: ReactNode;
  beforeLabel?: string;
  afterLabel?: string;
  className?: string;
  sizes?: string;
  priority?: boolean;
};

/**
 * Before/after comparison. Raw imagery on the left of the handle,
 * analyzed output on the right. Pointer, touch and keyboard accessible.
 */
export function BeforeAfter({
  before,
  after,
  alt,
  overlay,
  beforeLabel = "Raw imagery",
  afterLabel = "Analyzed",
  className,
  sizes = "(min-width: 1024px) 66vw, 100vw",
  priority,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(50);
  const [dragging, setDragging] = useState(false);
  const inView = useInView(ref, { once: true, margin: "0px 0px -25% 0px" });
  const reduce = useReducedMotion();
  const hinted = useRef(false);

  // A single, gentle hint that the frame is interactive.
  useEffect(() => {
    if (!inView || reduce || hinted.current) return;
    hinted.current = true;
    const controls = animate(82, 50, {
      duration: 1.8,
      delay: 0.3,
      ease: [0.65, 0, 0.35, 1],
      onUpdate: (v) => setPos(v),
    });
    return () => controls.stop();
  }, [inView, reduce]);

  const setFromClientX = useCallback((clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const p = ((clientX - r.left) / r.width) * 100;
    setPos(Math.max(0, Math.min(100, p)));
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    hinted.current = true;
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setFromClientX(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging) setFromClientX(e.clientX);
  };
  const onPointerUp = () => setDragging(false);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 2;
    let next = pos;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = pos - step;
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = pos + step;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = 100;
    else return;
    e.preventDefault();
    setPos(Math.max(0, Math.min(100, next)));
  };

  return (
    <div
      ref={ref}
      className={cn(
        "relative isolate cursor-ew-resize touch-pan-y select-none overflow-hidden bg-ink-850",
        className,
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <Image src={before} alt={alt} fill sizes={sizes} priority={priority} placeholder="blur" className="object-cover" draggable={false} />

      <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${pos}%)` }} aria-hidden="true">
        <Image src={after} alt="" fill sizes={sizes} className="object-cover" draggable={false} />
        {overlay}
      </div>

      {/* Labels */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3 md:p-4">
        <span
          className="t-mono max-w-[46%] truncate rounded-[2px] bg-ink-950/70 px-2 py-1 text-[0.625rem] uppercase tracking-[0.12em] text-bone-50/80 backdrop-blur transition-opacity md:text-[0.6875rem]"
          style={{ opacity: pos < 12 ? 0 : 1 }}
        >
          {beforeLabel}
        </span>
        <span
          className="t-mono max-w-[46%] truncate rounded-[2px] bg-ink-950/70 px-2 py-1 text-[0.625rem] uppercase tracking-[0.12em] text-bone-50/80 backdrop-blur transition-opacity md:text-[0.6875rem]"
          style={{ opacity: pos > 88 ? 0 : 1 }}
        >
          {afterLabel}
        </span>
      </div>

      {/* Handle */}
      <div className="pointer-events-none absolute inset-y-0" style={{ left: `${pos}%` }}>
        <div className="absolute inset-y-0 -left-px w-[2px] bg-bone-50 shadow-[0_0_0_1px_rgba(0,0,0,0.25)]" />
        <div
          role="slider"
          tabIndex={0}
          aria-label="Comparison position: raw imagery versus analyzed output"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pos)}
          aria-valuetext={`${Math.round(100 - pos)}% analyzed`}
          onKeyDown={onKeyDown}
          className={cn(
            "pointer-events-auto absolute top-1/2 grid size-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full",
            "border border-ink-950/10 bg-bone-50 text-ink-900 shadow-lg shadow-black/40 transition-transform duration-200",
            dragging ? "scale-95" : "hover:scale-105",
          )}
        >
          <svg viewBox="0 0 20 20" className="size-4" aria-hidden="true">
            <path d="M7 5l-5 5 5 5M13 5l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </div>
      </div>
    </div>
  );
}
