import type { ReactNode } from "react";
import { Eyebrow } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

/** Editorial chapter opener: full-width headline, supporting copy offset right. */
export function ChapterHeading({
  index,
  eyebrow,
  title,
  body,
  aside,
  id,
  tone = "dark",
  className,
}: {
  index?: string;
  eyebrow: string;
  title: ReactNode;
  body?: ReactNode;
  aside?: ReactNode;
  id: string;
  tone?: "dark" | "light";
  className?: string;
}) {
  return (
    <div className={className}>
      <Eyebrow index={index}>{eyebrow}</Eyebrow>
      <h2 id={id} className="t-h1 mt-6 uppercase">
        {title}
      </h2>
      {body || aside ? (
        <div className="mt-8 grid gap-6 md:mt-10 md:grid-cols-12">
          <div className="min-w-0 md:col-span-6 md:col-start-7 lg:col-span-5 lg:col-start-8">
            {body ? <p className={cn("t-lead", tone === "dark" ? "text-bone-50/70" : "text-ink-900/65")}>{body}</p> : null}
            {aside ? <div className="mt-6">{aside}</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
