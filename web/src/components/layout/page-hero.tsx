import Image from "next/image";
import type { ReactNode } from "react";
import type { MediaImage } from "@/content/media";
import { Eyebrow, MediaNote } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

/** Inner-page hero: full-bleed image, editorial headline, optional media. */
export function PageHero({
  eyebrow,
  title,
  lead,
  image,
  credit,
  children,
  media,
  tall = true,
}: {
  eyebrow: string;
  title: ReactNode;
  lead?: ReactNode;
  image?: MediaImage;
  credit?: string;
  children?: ReactNode;
  media?: ReactNode;
  tall?: boolean;
}) {
  return (
    <section className={cn("relative isolate flex overflow-hidden bg-ink-950", tall ? "min-h-[88svh] md:min-h-[92svh]" : "min-h-[64svh]")}>
      {media ??
        (image ? (
          <Image
            src={image.src}
            alt={image.alt}
            fill
            priority
            sizes="100vw"
            placeholder="blur"
            className="-z-10 animate-[hero-settle_2.4s_var(--ease-out-expo)_both] object-cover"
            style={{ objectPosition: image.focal }}
          />
        ) : null)}
      <div aria-hidden="true" className="absolute inset-x-0 top-0 -z-[5] h-48 bg-gradient-to-b from-ink-950/70 to-transparent" />
      <div aria-hidden="true" className="scrim-b absolute inset-0 -z-[5]" />
      <div className="shell flex w-full flex-col justify-end pb-12 pt-[calc(var(--header-h)+4rem)] md:pb-16">
        <Eyebrow className="animate-[fade_1.2s_var(--ease-out-expo)_0.2s_both]">{eyebrow}</Eyebrow>
        <h1 className="t-h1 mt-6 max-w-[16ch] animate-[fade_1.4s_var(--ease-out-expo)_0.3s_both] text-balance">{title}</h1>
        <div className="mt-8 grid gap-8 md:grid-cols-12 md:items-end">
          {lead ? <div className="t-lead animate-[fade_1.4s_var(--ease-out-expo)_0.45s_both] text-bone-50/75 md:col-span-6">{lead}</div> : null}
          {children ? <div className="animate-[fade_1.4s_var(--ease-out-expo)_0.55s_both] md:col-span-6 md:flex md:justify-end">{children}</div> : null}
        </div>
        {credit ? <MediaNote className="mt-10">{credit}</MediaNote> : null}
      </div>
    </section>
  );
}

/** Standard section heading block. */
export function SectionHeading({
  index,
  eyebrow,
  title,
  body,
  className,
  tone = "dark",
  aside,
  id,
}: {
  index?: string;
  eyebrow: string;
  title: ReactNode;
  body?: ReactNode;
  className?: string;
  tone?: "dark" | "light";
  aside?: ReactNode;
  id?: string;
}) {
  return (
    <div className={cn("grid gap-8 lg:grid-cols-12 lg:items-end", className)}>
      <div className="lg:col-span-7">
        <Eyebrow index={index}>{eyebrow}</Eyebrow>
        <h2 id={id} className="t-h2 mt-6 text-balance">
          {title}
        </h2>
      </div>
      {body || aside ? (
        <div className="lg:col-span-4 lg:col-start-9">
          {body ? <div className={cn("t-body", tone === "dark" ? "text-bone-50/65" : "text-ink-900/65")}>{body}</div> : null}
          {aside ? <div className="mt-6">{aside}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
