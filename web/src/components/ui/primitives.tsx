import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Section label: "02 — SensorDyme Aero" in mono. */
export function Eyebrow({
  index,
  children,
  className,
}: {
  index?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <p className={cn("t-eyebrow flex items-center gap-3 opacity-70", className)}>
      {index ? (
        <>
          <span className="tabular-nums">{index}</span>
          <span aria-hidden="true" className="h-px w-6 bg-current opacity-50" />
        </>
      ) : null}
      <span>{children}</span>
    </p>
  );
}

/** Compact status tag, e.g. "In development". */
export function StatusTag({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "signal" | "light"; className?: string }) {
  return (
    <span
      className={cn(
        "t-mono inline-flex items-center gap-2 whitespace-nowrap rounded-[2px] border px-2 py-1 text-[0.6875rem] uppercase tracking-[0.12em]",
        tone === "neutral" && "border-bone-50/15 text-bone-50/70",
        tone === "signal" && "border-signal/40 text-signal",
        tone === "light" && "border-ink-900/15 text-ink-900/70",
        className,
      )}
    >
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", tone === "signal" ? "bg-signal" : "bg-current opacity-60")} />
      {children}
    </span>
  );
}

/** Caption beneath imagery — accurate sourcing language lives here. */
export function MediaNote({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("t-mono text-[0.6875rem] opacity-60", className)}>{children}</p>;
}

/** Multi-line headline where each line is its own block. */
export function Lines({ lines, className }: { lines: string[]; className?: string }) {
  return (
    <span className={className}>
      {lines.map((l) => (
        <span key={l} className="block">
          {l}
        </span>
      ))}
    </span>
  );
}

export function Divider({ className }: { className?: string }) {
  return <hr className={cn("hairline border-t", className)} />;
}
