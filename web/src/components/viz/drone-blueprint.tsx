"use client";

import { motion, useInView, useReducedMotion } from "motion/react";
import { useRef } from "react";
import { MARK_PATH } from "@/components/brand/logo";
import { cn } from "@/lib/cn";

/**
 * SensorDyme Aero A1 — concept drawing (top view). An original illustration of the
 * planned development platform. Not a depiction of finished hardware.
 * The fuselage silhouette is derived from the ORYN mark.
 */

export type BlueprintPart = "airframe" | "propulsion" | "power" | "flight" | "compute" | "payload";

const C = 500;
const MOTOR = 250; // offset from center on each axis
const motors = [
  { x: C - MOTOR, y: C - MOTOR, rot: -18, dir: "CW" },
  { x: C + MOTOR, y: C - MOTOR, rot: 22, dir: "CCW" },
  { x: C + MOTOR, y: C + MOTOR, rot: -28, dir: "CW" },
  { x: C - MOTOR, y: C + MOTOR, rot: 14, dir: "CCW" },
];
const arms = [-135, -45, 45, 135];

const BLADE =
  "M-158 0C-120-17-46-15 0 0C46 15 120 17 158 0C120 9 46 11 0 0C-46-11-120-9-158 0Z";

// Mark scaled to form the fuselage: viewBox of mark is 117.23 × 144.33.
const BODY_SCALE = 1.5;
const BODY_X = C - 58.62 * BODY_SCALE;
const BODY_Y = C - 72 * BODY_SCALE;

export const blueprintCallouts: {
  part: BlueprintPart;
  n: string;
  label: string;
  point: [number, number];
  elbow: [number, number];
  text: [number, number];
  anchor: "start" | "end";
}[] = [
  { part: "payload", n: "01", label: "Sensor payload mount", point: [500, 368], elbow: [380, 150], text: [110, 150], anchor: "start" },
  { part: "propulsion", n: "02", label: "Propulsion unit", point: [785, 222], elbow: [860, 120], text: [960, 120], anchor: "end" },
  { part: "flight", n: "03", label: "Flight controller", point: [512, 500], elbow: [640, 430], text: [960, 430], anchor: "end" },
  { part: "power", n: "04", label: "Power system", point: [528, 572], elbow: [660, 640], text: [960, 640], anchor: "end" },
  { part: "compute", n: "05", label: "Edge compute", point: [470, 652], elbow: [340, 760], text: [40, 760], anchor: "start" },
  { part: "airframe", n: "06", label: "Serviceable arm", point: [338, 662], elbow: [250, 590], text: [40, 590], anchor: "start" },
];

export function DroneBlueprint({
  active,
  className,
  showCallouts = true,
  showTitleBlock = true,
}: {
  active?: BlueprintPart | null;
  className?: string;
  showCallouts?: boolean;
  showTitleBlock?: boolean;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -15% 0px" });
  const reduce = useReducedMotion();
  const shown = inView || !!reduce;

  const dim = (part: BlueprintPart) =>
    active && active !== part ? "opacity-25" : "opacity-100";
  const hl = (part: BlueprintPart) => active === part;

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

  return (
    <svg
      ref={ref}
      viewBox="0 0 1000 1000"
      className={cn("h-auto w-full select-none text-bone-50 [&_*]:[vector-effect:non-scaling-stroke]", className)}
      fill="none"
      role="img"
      aria-label="Concept drawing of the SensorDyme Aero A1 development platform, top view, with labeled modules"
    >
      <defs>
        <marker id="bp-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 1L9 5L0 9" stroke="currentColor" strokeWidth="1.2" fill="none" />
        </marker>
      </defs>

      {/* Centerlines */}
      <motion.g {...fade(0)} stroke="currentColor" strokeOpacity="0.18" strokeWidth="1" strokeDasharray="22 6 3 6">
        <line x1="40" y1={C} x2="960" y2={C} />
        <line x1={C} y1="40" x2={C} y2="960" />
        <line x1="180" y1="180" x2="820" y2="820" strokeOpacity="0.1" />
        <line x1="820" y1="180" x2="180" y2="820" strokeOpacity="0.1" />
      </motion.g>

      {/* Forward indicator */}
      <motion.g {...fade(0.4)} className="text-bone-50/50">
        <path d="M500 64V30M490 42l10-12 10 12" stroke="currentColor" strokeWidth="1.2" />
        <text x="516" y="48" className="fill-current font-mono text-[16px] tracking-[0.18em]">FWD</text>
      </motion.g>

      {/* Propeller discs & blades */}
      <g className={cn("transition-opacity duration-500", dim("propulsion"))}>
        {motors.map((m, i) => (
          <g key={`prop-${i}`} transform={`translate(${m.x} ${m.y})`}>
            <motion.circle
              r="168"
              stroke="currentColor"
              strokeOpacity={hl("propulsion") ? 0.6 : 0.3}
              strokeWidth="1"
              strokeDasharray="2 7"
              {...fade(0.6 + i * 0.08)}
            />
            <motion.path
              d={BLADE}
              transform={`rotate(${m.rot})`}
              stroke="currentColor"
              strokeOpacity={hl("propulsion") ? 0.95 : 0.55}
              strokeWidth="1.2"
              {...draw(0.9 + i * 0.08)}
            />
          </g>
        ))}
      </g>

      {/* Arms */}
      <g className={cn("transition-opacity duration-500", dim("airframe"))}>
        {arms.map((a) => (
          <g key={`arm-${a}`} transform={`rotate(${a} ${C} ${C})`}>
            <motion.path
              d={`M${C + 70} ${C - 12}H${C + 318}M${C + 70} ${C + 12}H${C + 318}`}
              stroke="currentColor"
              strokeOpacity={hl("airframe") ? 1 : 0.8}
              strokeWidth="1.5"
              {...draw(0.3)}
            />
            <motion.path
              d={`M${C + 110} ${C - 12}V${C + 12}M${C + 250} ${C - 12}V${C + 12}`}
              stroke="currentColor"
              strokeOpacity="0.35"
              strokeWidth="1"
              {...fade(1.2)}
            />
          </g>
        ))}
      </g>

      {/* Motors */}
      <g className={cn("transition-opacity duration-500", dim("propulsion"))}>
        {motors.map((m, i) => (
          <g key={`motor-${i}`} transform={`translate(${m.x} ${m.y})`}>
            <motion.circle r="38" stroke="currentColor" strokeWidth="1.5" {...draw(0.5 + i * 0.06)} />
            <motion.circle r="26" stroke="currentColor" strokeOpacity="0.6" strokeWidth="1" {...draw(0.7 + i * 0.06)} />
            <motion.g {...fade(1.1)} stroke="currentColor" strokeOpacity="0.6">
              <circle r="7" strokeWidth="1.2" />
              {[0, 90, 180, 270].map((deg) => (
                <circle key={deg} r="2.2" cx={Math.cos((deg * Math.PI) / 180) * 16} cy={Math.sin((deg * Math.PI) / 180) * 16} strokeWidth="1" />
              ))}
            </motion.g>
            <motion.text
              {...fade(1.4)}
              x={m.x < C ? -58 : 58}
              y={m.y < C ? -48 : 60}
              textAnchor={m.x < C ? "end" : "start"}
              className="fill-current font-mono text-[15px] tracking-[0.1em] opacity-50"
            >
              M{i + 1} · {m.dir}
            </motion.text>
          </g>
        ))}
      </g>

      {/* Fuselage — derived from the ORYN mark */}
      <g className={cn("transition-opacity duration-500", dim("airframe"))}>
        <motion.path
          d={MARK_PATH}
          transform={`translate(${BODY_X} ${BODY_Y}) scale(${BODY_SCALE})`}
          stroke="currentColor"
          strokeWidth={1.6 / BODY_SCALE}
          fill="var(--color-ink-950)"
          {...draw(0.1)}
        />
      </g>

      {/* Rear tray */}
      <g className={cn("transition-opacity duration-500", dim("compute"))}>
        <motion.rect x="452" y="610" width="96" height="74" rx="8" stroke="currentColor" strokeWidth="1.3" fill="var(--color-ink-950)" {...draw(0.6)} />
        <motion.rect
          x="466"
          y="626"
          width="68"
          height="40"
          rx="3"
          stroke={hl("compute") ? "var(--color-signal)" : "currentColor"}
          strokeOpacity={hl("compute") ? 1 : 0.7}
          strokeWidth="1.2"
          {...draw(0.9)}
        />
        <motion.g {...fade(1.3)} stroke="currentColor" strokeOpacity="0.45" strokeWidth="1">
          {[0, 1, 2, 3, 4].map((k) => (
            <line key={k} x1={474 + k * 13} y1="634" x2={474 + k * 13} y2="658" />
          ))}
        </motion.g>
      </g>

      {/* GNSS & antennas */}
      <motion.g {...fade(1.2)} className={cn("transition-opacity duration-500", dim("flight"))} stroke="currentColor" strokeWidth="1.2">
        <circle cx="500" cy="716" r="16" />
        <circle cx="500" cy="716" r="6" strokeOpacity="0.5" />
        <path d="M500 684V700" strokeOpacity="0.6" />
        <path d="M462 684l-26 34M538 684l26 34" strokeOpacity="0.8" />
      </motion.g>

      {/* Flight controller (visible through top hatch) */}
      <g className={cn("transition-opacity duration-500", dim("flight"))}>
        <motion.rect
          x="482"
          y="484"
          width="36"
          height="36"
          rx="3"
          stroke={hl("flight") ? "var(--color-signal)" : "currentColor"}
          strokeWidth="1.3"
          {...draw(0.8)}
        />
        <motion.path d="M500 512V494M494 500l6-6 6 6" stroke="currentColor" strokeOpacity="0.7" strokeWidth="1" {...fade(1.4)} />
      </g>

      {/* Power — hidden lines (dashed) beneath the hatch */}
      <motion.rect
        {...fade(1.0)}
        x="470"
        y="530"
        width="60"
        height="64"
        rx="4"
        stroke={hl("power") ? "var(--color-signal)" : "currentColor"}
        strokeOpacity={active && active !== "power" ? 0.15 : hl("power") ? 1 : 0.5}
        strokeWidth="1.2"
        strokeDasharray="6 5"
        className="transition-[stroke-opacity] duration-500"
      />

      {/* Payload — gimbal camera at the nose */}
      <g className={cn("transition-opacity duration-500", dim("payload"))}>
        <motion.rect x="478" y="356" width="44" height="30" rx="6" stroke="currentColor" strokeWidth="1.3" fill="var(--color-ink-950)" {...draw(0.7)} />
        <motion.circle
          cx="500"
          cy="364"
          r="17"
          stroke={hl("payload") ? "var(--color-signal)" : "currentColor"}
          strokeWidth="1.4"
          fill="var(--color-ink-950)"
          {...draw(0.9)}
        />
        <motion.circle cx="500" cy="364" r="8" stroke="currentColor" strokeOpacity="0.6" strokeWidth="1" {...fade(1.4)} />
      </g>

      {/* Dimension line — values not yet established */}
      <motion.g {...fade(1.6)} stroke="currentColor" strokeOpacity="0.4" strokeWidth="1" className="text-bone-50">
        <path d={`M${C - MOTOR} ${C + MOTOR + 48}V${C + MOTOR + 110}M${C + MOTOR} ${C + MOTOR + 48}V${C + MOTOR + 110}`} />
        <path d={`M${C - MOTOR + 4} ${C + MOTOR + 95}H${C + MOTOR - 4}`} markerStart="url(#bp-arrow)" markerEnd="url(#bp-arrow)" />
        <text x={C} y={C + MOTOR + 85} textAnchor="middle" stroke="none" className="fill-current font-mono text-[15px] tracking-[0.1em] opacity-80">
          MOTOR SPACING — TBD
        </text>
      </motion.g>

      {/* Callouts */}
      {showCallouts ? (
        <g className="max-md:hidden">
          {blueprintCallouts.map((c, i) => {
            const isActive = hl(c.part);
            return (
              <motion.g key={c.n} {...fade(1.6 + i * 0.1)} className={cn("transition-opacity duration-500", active && !isActive ? "opacity-30" : "opacity-100")}>
                <polyline
                  points={`${c.point[0]},${c.point[1]} ${c.elbow[0]},${c.elbow[1]} ${c.text[0] + (c.anchor === "start" ? 0 : 0)},${c.elbow[1]}`}
                  stroke={isActive ? "var(--color-signal)" : "currentColor"}
                  strokeOpacity={isActive ? 1 : 0.45}
                  strokeWidth="1"
                />
                <circle cx={c.point[0]} cy={c.point[1]} r="3.5" fill={isActive ? "var(--color-signal)" : "currentColor"} />
                <text
                  x={c.text[0]}
                  y={c.elbow[1] - 10}
                  textAnchor={c.anchor}
                  className={cn("font-mono text-[17px] tracking-[0.06em]", isActive ? "fill-signal" : "fill-current")}
                >
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
          <rect x="680" y="880" width="280" height="80" stroke="currentColor" strokeOpacity="0.35" />
          <line x1="680" y1="910" x2="960" y2="910" stroke="currentColor" strokeOpacity="0.35" />
          <line x1="850" y1="910" x2="850" y2="960" stroke="currentColor" strokeOpacity="0.35" />
          <text x="692" y="901" className="fill-current font-mono text-[15px] tracking-[0.12em] opacity-80">AERO A1 · CONCEPT</text>
          <text x="692" y="932" className="fill-current font-mono text-[13px] tracking-[0.08em] opacity-50">TOP VIEW</text>
          <text x="692" y="951" className="fill-current font-mono text-[13px] tracking-[0.08em] opacity-50">NOT TO SCALE</text>
          <text x="862" y="932" className="fill-current font-mono text-[13px] tracking-[0.08em] opacity-50">REV 0.1</text>
          <text x="862" y="951" className="fill-current font-mono text-[13px] tracking-[0.08em] opacity-50">IN DEV</text>
        </motion.g>
      ) : null}
    </svg>
  );
}
