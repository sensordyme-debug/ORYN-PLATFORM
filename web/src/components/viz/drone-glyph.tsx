import { MARK_PATH } from "@/components/brand/logo";
import { cn } from "@/lib/cn";

/** Solid top-down aircraft silhouette for use over imagery. Concept only. */
export function DroneGlyph({ className, spinning = true }: { className?: string; spinning?: boolean }) {
  const motors: [number, number][] = [
    [92, 92],
    [308, 92],
    [308, 308],
    [92, 308],
  ];
  return (
    <svg viewBox="0 0 400 400" className={cn("h-auto w-full", className)} aria-hidden="true">
      {motors.map(([x, y], i) => (
        <g key={i} transform={`translate(${x} ${y})`}>
          <circle r="74" fill="rgba(242,241,237,0.09)" stroke="rgba(242,241,237,0.55)" strokeWidth="1.5" />
          <g className={spinning ? "origin-center motion-safe:animate-[spin_0.45s_linear_infinite]" : undefined} style={{ transformBox: "fill-box" }}>
            <rect x="-70" y="-3" width="140" height="6" rx="3" fill="rgba(242,241,237,0.35)" />
          </g>
        </g>
      ))}
      <g stroke="#f2f1ed" strokeWidth="15" strokeLinecap="round">
        <line x1="200" y1="200" x2="92" y2="92" />
        <line x1="200" y1="200" x2="308" y2="92" />
        <line x1="200" y1="200" x2="308" y2="308" />
        <line x1="200" y1="200" x2="92" y2="308" />
      </g>
      {motors.map(([x, y], i) => (
        <g key={`m${i}`}>
          <circle cx={x} cy={y} r="20" fill="#f2f1ed" />
          <circle cx={x} cy={y} r="7" fill="#0a0b0c" />
        </g>
      ))}
      <path d={MARK_PATH} transform="translate(141.4 128) scale(1.0)" fill="#f2f1ed" stroke="#0a0b0c" strokeWidth="3" />
      <circle cx="200" cy="122" r="11" fill="#0a0b0c" stroke="#f2f1ed" strokeWidth="3" />
    </svg>
  );
}
