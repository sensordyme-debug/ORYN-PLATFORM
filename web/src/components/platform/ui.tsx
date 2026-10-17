/**
 * Platform UI primitives — dense, restrained, built on the ORYN tokens in
 * globals.css (ink surfaces, bone type, hairlines, mono labels).
 */
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { dataCurrency, formatDateTime, relativeTime, type Dateish } from "@/lib/format";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-col gap-4 border-b border-bone-50/[0.08] pb-5 md:flex-row md:items-end md:justify-between", className)}>
      <div className="min-w-0">
        {eyebrow ? <p className="t-eyebrow text-bone-50/50">{eyebrow}</p> : null}
        <h1 className="mt-1.5 text-[1.5rem] font-medium tracking-[-0.025em] md:text-[1.75rem]">{title}</h1>
        {description ? <p className="mt-1.5 max-w-3xl text-[0.875rem] leading-relaxed text-bone-50/60">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cn("rounded-[4px] border border-bone-50/[0.09] bg-ink-850", className)}>
      {title || actions ? (
        <div className="flex items-start justify-between gap-3 border-b border-bone-50/[0.07] px-4 py-3">
          <div className="min-w-0">
            {title ? <h2 className="text-[0.9375rem] font-medium tracking-[-0.01em]">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-[0.8125rem] text-bone-50/55">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={cn("p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

type Tone = "neutral" | "info" | "good" | "watch" | "alert" | "signal" | "muted";

const toneClass: Record<Tone, string> = {
  neutral: "border-bone-50/15 text-bone-50/75",
  info: "border-data-water/40 text-data-water",
  good: "border-data-veg/40 text-data-veg",
  watch: "border-data-amber/40 text-data-amber",
  alert: "border-data-alert/45 text-data-alert",
  signal: "border-signal/45 text-signal",
  muted: "border-bone-50/10 text-bone-50/45",
};

export function Badge({ tone = "neutral", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "t-mono inline-flex items-center gap-1.5 whitespace-nowrap rounded-[2px] border px-1.5 py-0.5 text-[0.6875rem] uppercase tracking-[0.08em]",
        toneClass[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export const SEVERITY_TONE: Record<string, Tone> = { info: "neutral", low: "info", moderate: "watch", high: "alert", critical: "signal" };
export const EVIDENCE_TONE: Record<string, Tone> = { strong: "good", moderate: "watch", weak: "muted", insufficient: "muted" };
export const VERIFICATION_TONE: Record<string, Tone> = { unverified: "neutral", needs_field_check: "watch", confirmed: "good", dismissed: "muted" };

/** Labels that keep the analytical categories distinct everywhere they appear. */
export const RESULT_CLASS_LABEL: Record<string, string> = {
  raw_observation: "Raw observation",
  deterministic_calculation: "Calculation",
  model_prediction: "Model prediction",
  candidate_change: "Candidate change — unverified",
  rule_evaluation: "Rule evaluation",
};

export function ResultClassBadge({ resultClass, verified }: { resultClass: string; verified?: boolean }) {
  const label = resultClass === "candidate_change" && verified ? "Candidate change — verified by analyst" : RESULT_CLASS_LABEL[resultClass] ?? resultClass;
  const tone: Tone = resultClass === "candidate_change" ? (verified ? "good" : "watch") : resultClass === "model_prediction" ? "info" : "neutral";
  return <Badge tone={tone}>{label}</Badge>;
}

const currencyTone = { current: "good", recent: "info", aging: "watch", stale: "alert", none: "muted" } as const;
const currencyLabel = { current: "Current", recent: "Recent", aging: "Aging", stale: "Stale", none: "No data" } as const;

/** Shows how old a piece of data is, with the absolute time on hover. */
export function DataAge({ at, label, now, timeZone }: { at: Dateish; label?: string; now?: Date; timeZone?: string }) {
  const c = dataCurrency(at, now);
  return (
    <span className="inline-flex flex-wrap items-center gap-2" title={formatDateTime(at, timeZone)}>
      <Badge tone={currencyTone[c]}>{currencyLabel[c]}</Badge>
      <span className="text-[0.8125rem] text-bone-50/70">
        {label ? `${label} ` : ""}
        {relativeTime(at, now)}
      </span>
    </span>
  );
}

export function Stat({ label, value, detail, className }: { label: ReactNode; value: ReactNode; detail?: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <p className="t-eyebrow text-bone-50/50">{label}</p>
      <p className="mt-1.5 text-[1.375rem] font-medium tabular-nums tracking-[-0.02em]">{value}</p>
      {detail ? <p className="mt-0.5 text-[0.75rem] text-bone-50/50">{detail}</p> : null}
    </div>
  );
}

export function KeyValues({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1.5 text-[0.8125rem]", className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-bone-50/50">{k}</dt>
          <dd className="min-w-0 break-words text-bone-50/85">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function EmptyState({ title, children, action, className }: { title: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-[4px] border border-dashed border-bone-50/15 px-6 py-10 text-center", className)}>
      <p className="text-[0.9375rem] font-medium">{title}</p>
      {children ? <div className="mx-auto mt-1.5 max-w-lg text-[0.8125rem] leading-relaxed text-bone-50/55">{children}</div> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function Notice({ tone = "info", title, children, className }: { tone?: "info" | "warn" | "error" | "success"; title?: ReactNode; children?: ReactNode; className?: string }) {
  const styles = {
    info: "border-data-water/30 bg-data-water/[0.06]",
    warn: "border-data-amber/35 bg-data-amber/[0.07]",
    error: "border-data-alert/40 bg-data-alert/[0.08]",
    success: "border-data-veg/35 bg-data-veg/[0.07]",
  }[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cn("rounded-[4px] border px-3.5 py-2.5 text-[0.8125rem] leading-relaxed", styles, className)}>
      {title ? <p className="font-medium text-bone-50">{title}</p> : null}
      {children ? <div className={cn("text-bone-50/75", title && "mt-0.5")}>{children}</div> : null}
    </div>
  );
}

type BtnVariant = "primary" | "secondary" | "ghost" | "danger";
const btnBase =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[3px] text-[0.8125rem] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";
const btnVariants: Record<BtnVariant, string> = {
  primary: "bg-bone-50 text-ink-900 hover:bg-white",
  secondary: "border border-bone-50/20 text-bone-50 hover:border-bone-50/50 hover:bg-bone-50/[0.04]",
  ghost: "text-bone-50/70 hover:bg-bone-50/[0.06] hover:text-bone-50",
  danger: "border border-data-alert/45 text-data-alert hover:bg-data-alert/10",
};
const btnSizes = { sm: "h-7 px-2.5", md: "h-9 px-3.5" } as const;

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ComponentProps<"button"> & { variant?: BtnVariant; size?: keyof typeof btnSizes }) {
  return <button type="button" className={cn(btnBase, btnVariants[variant], btnSizes[size], className)} {...props} />;
}

export function LinkButton({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ComponentProps<typeof Link> & { variant?: BtnVariant; size?: keyof typeof btnSizes }) {
  return <Link className={cn(btnBase, btnVariants[variant], btnSizes[size], className)} {...props} />;
}

export const inputClass =
  "w-full rounded-[3px] border border-bone-50/15 bg-ink-950 px-2.5 py-1.5 text-[0.875rem] text-bone-50 placeholder:text-bone-50/30 focus:border-bone-50/50 focus:outline-none disabled:opacity-50";

export function Field({ label, hint, error, children, htmlFor, className }: { label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; htmlFor?: string; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label htmlFor={htmlFor} className="text-[0.8125rem] text-bone-50/75">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-[0.75rem] text-data-alert" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[0.75rem] text-bone-50/45">{hint}</p>
      ) : null}
    </div>
  );
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full border-collapse text-left text-[0.8125rem]">{children}</table>
    </div>
  );
}
export const th = "border-b border-bone-50/[0.08] px-3 py-2 font-normal t-eyebrow text-bone-50/45 whitespace-nowrap";
export const td = "border-b border-bone-50/[0.05] px-3 py-2 align-top text-bone-50/85";

export function TrialBanner({ sharedAccount }: { sharedAccount: boolean }) {
  return (
    <div className="border-b border-data-amber/30 bg-data-amber/[0.08] px-4 py-1.5 text-[0.75rem] text-data-amber">
      Trial workspace. Areas and records here are synthetic sample data, not a real customer&apos;s; imagery and measurements over them are
      real.{sharedAccount ? " You are using a shared trial account — do not enter or upload anything confidential." : ""}
    </div>
  );
}

export function SyntheticBanner() {
  return (
    <div className="border-b border-data-amber/30 bg-data-amber/[0.08] px-4 py-1.5 text-[0.75rem] text-data-amber">
      Synthetic development organization. Boundaries and records here are sample data, not a real customer&apos;s. Imagery and
      measurements over them are real.
    </div>
  );
}
