"use client";

import { motion, useInView, useReducedMotion } from "motion/react";
import { useRef } from "react";
import { cn } from "@/lib/cn";

/**
 * SensorDyme Edge — blueprint drawing: front (camera face) and side views,
 * with hidden-line internals. Companion to the Aero concept drawing; same
 * line weights, callouts, and title block. Proportions are illustrative.
 */

export type EdgePart = "enclosure" | "camera" | "night" | "compute" | "accelerator" | "alerts" | "power";

const U = 62; // one proportion unit, in drawing pixels
const Y0 = 250; // top edge of both views
const FX = 70; // front view: 4 × 3
const SX = 430; // side view: 6 × 3 (front of the device is on the right)
const FW = 4 * U;
const HH = 3 * U;
const SW = 6 * U;
const LID = 0.55 * U * 0.62;

export const edgeCallouts: { part: EdgePart; n: string; label: string; point: [number, number]; text: [number, number]; anchor: "start" | "end" }[] = [
  { part: "camera", n: "01", label: "Camera", point: [FX + 62, Y0 + 80], text: [FX - 10, Y0 - 70], anchor: "start" },
  { part: "night", n: "02", label: "IR illuminator", point: [FX + 170, Y0 + 80], text: [FX + 170, Y0 - 40], anchor: "start" },
  { part: "alerts", n: "03", label: "Status light · buzzer", point: [FX + 90, Y0 + 152], text: [FX - 10, Y0 + HH + 90], anchor: "start" },
  { part: "enclosure", n: "04", label: "Removable lid", point: [SX + 150, Y0 + LID / 2], text: [SX + 120, Y0 - 70], anchor: "start" },
  { part: "accelerator", n: "05", label: "AI HAT+ · Hailo-8L", point: [SX + 200, Y0 + 104], text: [SX + SW + 10, Y0 - 40], anchor: "end" },
  { part: "compute", n: "06", label: "Raspberry Pi 5", point: [SX + 150, Y0 + 140], text: [SX + 150, Y0 + HH + 90], anchor: "start" },
  { part: "power", n: "07", label: "USB-C", point: [SX + 4, Y0 + 152], text: [SX - 6, Y0 + HH + 130], anchor: "start" },
];

export function EdgeBlueprint({
  active,
  className,
  showCallouts = true,
  showTitleBlock = true,
}: {
  active?: EdgePart | null;
  className?: string;
  showCallouts?: boolean;
  showTitleBlock?: boolean;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -15% 0px" });
  const reduce = useReducedMotion();
  const shown = inView || !!reduce;

  const dim = (part: EdgePart) => (active && active !== part ? "opacity-25" : "opacity-100");
  const hl = (part: EdgePart) => (active === part ? "var(--color-signal)" : "currentColor");
  const draw = (delay: number) => ({
    initial: { pathLength: 0, opacity: 0 },
    animate: shown ? { pathLength: 1, opacity: 1 } : {},
    transition: { duration: 1.1, delay: delay * 0.55, ease: [0.65, 0, 0.35, 1] as const },
  });
  const fade = (delay: number) => ({
    initial: { opacity: 0 },
    animate: shown ? { opacity: 1 } : {},
    transition: { duration: 0.8, delay: delay * 0.55, ease: "easeOut" as const },
  });
  const hidden = { strokeDasharray: "6 5", strokeOpacity: 0.55, strokeWidth: 1.1 };
  const lensX = FX + 62;
  const midY = Y0 + 80;

  return (
    <svg
      ref={ref}
      viewBox={showCallouts || showTitleBlock ? "0 0 900 640" : "20 196 870 320"}
      className={cn("h-auto w-full select-none text-bone-50 [&_*]:[vector-effect:non-scaling-stroke]", className)}
      fill="none"
      role="img"
      aria-label="Blueprint drawing of SensorDyme Edge: front view with the camera, infrared windows and status light, and a side view showing the camera module, Raspberry Pi 5, AI HAT+ accelerator, and USB-C power inside."
    >
      <defs>
        <marker id="eb-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 1L9 5L0 9" stroke="currentColor" strokeWidth="1.2" fill="none" />
        </marker>
      </defs>

      {/* Centerlines */}
      <motion.g {...fade(0)} stroke="currentColor" strokeOpacity="0.18" strokeWidth="1" strokeDasharray="22 6 3 6">
        <line x1={20} y1={midY} x2={880} y2={midY} />
        <line x1={lensX} y1={Y0 - 40} x2={lensX} y2={Y0 + HH + 40} />
      </motion.g>

      {/* ── FRONT VIEW (camera face, 4 × 3) ── */}
      <g className={cn("transition-opacity duration-500", dim("enclosure"))}>
        <motion.rect x={FX} y={Y0} width={FW} height={HH} rx="14" stroke={hl("enclosure")} strokeWidth="1.6" fill="var(--color-ink-950)" {...draw(0.1)} />
        <motion.line x1={FX} y1={Y0 + LID} x2={FX + FW} y2={Y0 + LID} stroke="currentColor" strokeOpacity="0.4" strokeWidth="1" {...fade(0.9)} />
        <motion.rect x={FX + 14} y={Y0 + 44} width={FW - 28} height={74} rx="10" stroke="currentColor" strokeOpacity="0.7" strokeWidth="1.2" {...draw(0.5)} />
      </g>
      <g className={cn("transition-opacity duration-500", dim("camera"))}>
        <motion.circle cx={lensX} cy={midY} r="26" stroke={hl("camera")} strokeWidth="1.6" fill="var(--color-ink-950)" {...draw(0.7)} />
        <motion.circle cx={lensX} cy={midY} r="16" stroke="currentColor" strokeOpacity="0.6" strokeWidth="1" {...draw(0.9)} />
        <motion.circle cx={lensX} cy={midY} r="5" stroke="currentColor" strokeOpacity="0.6" strokeWidth="1" {...fade(1.2)} />
      </g>
      <g className={cn("transition-opacity duration-500", dim("night"))}>
        {[150, 196].map((x) => (
          <motion.circle key={x} cx={FX + x} cy={midY} r="13" stroke={hl("night")} strokeOpacity="0.85" strokeWidth="1.2" {...draw(0.9)} />
        ))}
      </g>
      <g className={cn("transition-opacity duration-500", dim("alerts"))}>
        <motion.line x1={FX + 50} y1={Y0 + 152} x2={FX + 140} y2={Y0 + 152} stroke={hl("alerts")} strokeWidth="3" strokeLinecap="round" {...draw(1)} />
        <motion.g {...fade(1.3)} fill="currentColor" fillOpacity="0.5">
          {Array.from({ length: 12 }, (_, i) => (
            <circle key={i} cx={FX + 172 + (i % 6) * 9} cy={Y0 + 146 + Math.floor(i / 6) * 10} r="1.8" />
          ))}
        </motion.g>
      </g>
      <motion.text {...fade(1.5)} x={FX + FW / 2} y={Y0 + HH + 36} textAnchor="middle" className="fill-current font-mono text-[14px] tracking-[0.16em] opacity-60">
        FRONT · CAMERA FACE
      </motion.text>

      {/* ── SIDE VIEW (6 deep × 3 tall, front on the right) ── */}
      <g className={cn("transition-opacity duration-500", dim("enclosure"))}>
        <motion.rect x={SX} y={Y0} width={SW} height={HH} rx="14" stroke={hl("enclosure")} strokeWidth="1.6" fill="var(--color-ink-950)" {...draw(0.2)} />
        <motion.line x1={SX} y1={Y0 + LID} x2={SX + SW} y2={Y0 + LID} stroke={hl("enclosure")} strokeOpacity="0.5" strokeWidth="1" {...fade(0.9)} />
        <motion.g {...fade(1.1)} stroke="currentColor" strokeOpacity="0.4">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <line key={i} x1={SX + 70 + i * 22} y1={Y0 - 1} x2={SX + 70 + i * 22 + 12} y2={Y0 - 1} />
          ))}
        </motion.g>
        {/* lens protrudes from the front face */}
        <motion.rect x={SX + SW} y={midY - 22} width="10" height="44" rx="2" stroke="currentColor" strokeWidth="1.2" {...draw(0.7)} />
      </g>
      <g className={cn("transition-opacity duration-500", dim("camera"))}>
        <motion.rect x={SX + SW - 30} y={midY - 34} width="8" height="68" stroke={hl("camera")} {...hidden} {...fade(1.1)} />
        <motion.path d={`M${SX + SW - 30} ${midY + 20}H${SX + SW - 54}V${Y0 + 116}H${SX + SW - 120}`} stroke={hl("camera")} {...hidden} {...fade(1.2)} />
      </g>
      <g className={cn("transition-opacity duration-500", dim("accelerator"))}>
        <motion.rect x={SX + 48} y={Y0 + 98} width={U * 3.4} height="8" stroke={hl("accelerator")} {...hidden} {...fade(1.2)} />
        <motion.rect x={SX + 180} y={Y0 + 90} width="40" height="8" stroke={hl("accelerator")} {...hidden} {...fade(1.3)} />
      </g>
      <g className={cn("transition-opacity duration-500", dim("compute"))}>
        <motion.rect x={SX + 26} y={Y0 + 136} width={U * 4.6} height="8" stroke={hl("compute")} {...hidden} {...fade(1.2)} />
        <motion.rect x={SX + 26} y={Y0 + 112} width="44" height="24" stroke={hl("compute")} {...hidden} {...fade(1.3)} />
        <motion.rect x={SX + 120} y={Y0 + 118} width="46" height="18" stroke={hl("compute")} {...hidden} {...fade(1.3)} />
      </g>
      <g className={cn("transition-opacity duration-500", dim("alerts"))}>
        <motion.rect x={SX + SW - 34} y={Y0 + 140} width="20" height="32" stroke={hl("alerts")} {...hidden} {...fade(1.3)} />
      </g>
      <g className={cn("transition-opacity duration-500", dim("power"))}>
        <motion.rect x={SX - 14} y={Y0 + 146} width="14" height="12" stroke={hl("power")} strokeWidth="1.2" {...draw(1.1)} />
      </g>
      <motion.text {...fade(1.5)} x={SX + SW / 2} y={Y0 + HH + 36} textAnchor="middle" className="fill-current font-mono text-[14px] tracking-[0.16em] opacity-60">
        SIDE · FRONT →
      </motion.text>

      {/* Proportion lines — no published dimensions */}
      <motion.g {...fade(1.6)} stroke="currentColor" strokeOpacity="0.4" strokeWidth="1" className="text-bone-50">
        <path d={`M${SX} ${Y0 + HH + 58}H${SX + SW}`} markerStart="url(#eb-arrow)" markerEnd="url(#eb-arrow)" />
        <path d={`M${FX} ${Y0 + HH + 58}H${FX + FW}`} markerStart="url(#eb-arrow)" markerEnd="url(#eb-arrow)" />
        <path d={`M${FX - 28} ${Y0}V${Y0 + HH}`} markerStart="url(#eb-arrow)" markerEnd="url(#eb-arrow)" />
      </motion.g>

      {/* Callouts */}
      {showCallouts ? (
        <g className="max-md:hidden">
          {edgeCallouts.map((c, i) => {
            const on = active === c.part;
            return (
              <motion.g key={c.n} {...fade(1.7 + i * 0.08)} className={cn("transition-opacity duration-500", active && !on ? "opacity-30" : "opacity-100")}>
                <polyline
                  points={`${c.point[0]},${c.point[1]} ${c.text[0] + (c.anchor === "end" ? 0 : 0)},${c.text[1] + 6}`}
                  stroke={on ? "var(--color-signal)" : "currentColor"}
                  strokeOpacity={on ? 1 : 0.45}
                  strokeWidth="1"
                />
                <circle cx={c.point[0]} cy={c.point[1]} r="3.5" fill={on ? "var(--color-signal)" : "currentColor"} />
                <text x={c.text[0]} y={c.text[1]} textAnchor={c.anchor} className={cn("font-mono text-[15px] tracking-[0.06em]", on ? "fill-signal" : "fill-current")}>
                  {c.n} {c.label.toUpperCase()}
                </text>
              </motion.g>
            );
          })}
        </g>
      ) : null}

      {/* Title block */}
      {showTitleBlock ? (
        <motion.g {...fade(1.8)} className="text-bone-50 max-sm:hidden">
          <rect x="600" y="560" width="280" height="62" stroke="currentColor" strokeOpacity="0.35" />
          <line x1="600" y1="586" x2="880" y2="586" stroke="currentColor" strokeOpacity="0.35" />
          <text x="612" y="578" className="fill-current font-mono text-[14px] tracking-[0.12em] opacity-80">SENSORDYME EDGE · BLUEPRINT</text>
          <text x="612" y="606" className="fill-current font-mono text-[12px] tracking-[0.08em] opacity-50">ILLUSTRATIVE · NOT TO SCALE</text>
        </motion.g>
      ) : null}
    </svg>
  );
}
