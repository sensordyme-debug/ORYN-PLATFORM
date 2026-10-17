import Image from "next/image";
import Link from "next/link";
import { industries } from "@/content/industries";
import { cn } from "@/lib/cn";

/** Full-viewport panels that stack over one another as the page scrolls. */
export function IndustriesStack() {
  return (
    <div className="relative">
      {industries.map((ind, i) => {
        const right = i % 2 === 1;
        return (
          <article
            key={ind.slug}
            aria-labelledby={`ind-${ind.slug}`}
            className="sticky top-0 isolate flex h-[92svh] min-h-[560px] overflow-hidden bg-ink-950 md:h-[100svh]"
          >
            <div className="absolute inset-0 -z-10">
              <Image
                src={ind.image.src}
                alt={ind.image.alt}
                fill
                sizes="100vw"
                placeholder="blur"
                className="object-cover"
                style={{ objectPosition: ind.image.focal }}
              />
            </div>
            <div aria-hidden="true" className="absolute inset-0 -z-[5] bg-ink-950/25" />
            <div
              aria-hidden="true"
              className={cn(
                "absolute inset-0 -z-[5]",
                right
                  ? "bg-[linear-gradient(to_top,rgb(6_7_7/0.9),rgb(6_7_7/0.2)_55%,transparent),linear-gradient(to_left,rgb(6_7_7/0.6),transparent_60%)]"
                  : "bg-[linear-gradient(to_top,rgb(6_7_7/0.9),rgb(6_7_7/0.2)_55%,transparent),linear-gradient(to_right,rgb(6_7_7/0.6),transparent_60%)]",
              )}
            />
            <div className="shell flex w-full flex-col justify-between pb-10 pt-[calc(var(--header-h)+1.5rem)] md:pb-16">
              <div className="flex items-baseline justify-between">
                <p className="t-eyebrow text-bone-50/70">
                  <span className="tabular-nums">{ind.index}</span> / 05 — {ind.name}
                </p>
                <p className="t-mono hidden text-bone-50/60 md:block">Applications</p>
              </div>
              <div className={cn("grid gap-6 md:grid-cols-12", right && "md:text-right")}>
                <div className={cn("md:col-span-7", right && "md:col-start-6")}>
                  <h3 id={`ind-${ind.slug}`} className="t-h1 text-balance">
                    {ind.headline}
                  </h3>
                  <p className={cn("t-lead mt-6 max-w-xl text-bone-50/75", right && "md:ml-auto")}>{ind.summary}</p>
                  <Link
                    href={`/solutions/${ind.slug}`}
                    className="group mt-8 inline-flex items-center gap-3 text-[0.9375rem] font-medium"
                  >
                    <span className="border-b border-bone-50/40 pb-1 transition-colors group-hover:border-bone-50">
                      Explore {ind.name.toLowerCase()}
                    </span>
                    <span aria-hidden="true" className="transition-transform duration-300 group-hover:translate-x-1">
                      →
                    </span>
                  </Link>
                </div>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
