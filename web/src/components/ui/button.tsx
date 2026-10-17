import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "dark";

const base =
  "group/btn relative inline-flex items-center justify-center gap-3 whitespace-nowrap select-none " +
  "h-12 px-6 text-[0.9375rem] font-medium tracking-[-0.01em] rounded-[2px] " +
  "transition-[background-color,color,border-color,transform] duration-300 ease-out " +
  "active:scale-[0.985]";

const variants: Record<Variant, string> = {
  primary: "bg-bone-50 text-ink-900 hover:bg-white",
  secondary:
    "border border-bone-50/30 text-bone-50 hover:border-bone-50/80 hover:bg-bone-50/[0.06] backdrop-blur-[2px]",
  ghost: "border border-ink-900/20 text-ink-900 hover:border-ink-900/70",
  dark: "bg-ink-900 text-bone-50 hover:bg-ink-700",
};

export function Arrow({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={cn("size-4 shrink-0 transition-transform duration-300 ease-out group-hover/btn:translate-x-0.5", className)}
    >
      <path d="M2 8h11M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" />
    </svg>
  );
}

type ButtonLinkProps = Omit<ComponentProps<typeof Link>, "className"> & {
  variant?: Variant;
  className?: string;
  arrow?: boolean;
  children: ReactNode;
};

export function ButtonLink({ variant = "primary", className, arrow = true, children, ...props }: ButtonLinkProps) {
  return (
    <Link className={cn(base, variants[variant], className)} {...props}>
      <span>{children}</span>
      {arrow ? <Arrow /> : null}
    </Link>
  );
}

type TextLinkProps = Omit<ComponentProps<typeof Link>, "className"> & {
  className?: string;
  children: ReactNode;
};

/** Understated editorial link with animated underline and arrow. */
export function TextLink({ className, children, ...props }: TextLinkProps) {
  return (
    <Link
      className={cn(
        "group/btn inline-flex items-center gap-2.5 text-[0.9375rem] font-medium tracking-[-0.01em]",
        className,
      )}
      {...props}
    >
      <span className="relative">
        {children}
        <span className="absolute -bottom-1 left-0 h-px w-full origin-left scale-x-100 bg-current opacity-30 transition-[opacity,transform] duration-500 ease-out group-hover/btn:opacity-100" />
      </span>
      <Arrow />
    </Link>
  );
}
