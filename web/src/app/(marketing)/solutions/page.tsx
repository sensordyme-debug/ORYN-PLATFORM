import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { PageHero, SectionHeading } from "@/components/layout/page-hero";
import { ButtonLink } from "@/components/ui/button";
import { Reveal } from "@/components/ui/reveal";
import { industries } from "@/content/industries";
import { media } from "@/content/media";

export const metadata: Metadata = {
  title: "Solutions",
  description:
    "ORYN is developing managed aerial intelligence for agriculture, environmental monitoring, construction, disaster assessment, and search and rescue support.",
  alternates: { canonical: "/solutions" },
};

const engagement = [
  ["Scope", "We learn what you need to know, how often, and over what area."],
  ["Plan", "We design a repeatable survey and handle airspace and permissions."],
  ["Operate", "We fly, process, analyze, and review — on schedule."],
  ["Deliver", "You get findings, maps, and reports in ORYN Portal."],
];

export default function SolutionsPage() {
  return (
    <>
      <PageHero
        eyebrow="Solutions"
        title="Aerial intelligence for the work that matters."
        lead="We're developing managed aerial intelligence for five areas where seeing more — consistently, and from above — can change how decisions are made."
        image={media.environment2}
        credit="Photo: Cosmin Andrei Buzamat / Unsplash"
      />

      <section aria-labelledby="industries-title" className="bg-ink-950 py-28 md:py-36">
        <div className="shell">
          <h2 id="industries-title" className="sr-only">
            Industries
          </h2>
          <ul className="border-t border-bone-50/10">
            {industries.map((ind) => (
              <Reveal as="li" key={ind.slug} className="border-b border-bone-50/10">
                <Link href={`/solutions/${ind.slug}`} className="group grid gap-6 py-8 md:grid-cols-12 md:items-center md:gap-8 md:py-10">
                  <div className="relative aspect-[16/9] overflow-hidden rounded-[2px] bg-ink-850 md:col-span-4 md:aspect-[4/3]">
                    <Image
                      src={ind.image.src}
                      alt={ind.image.alt}
                      fill
                      sizes="(min-width: 768px) 33vw, 100vw"
                      placeholder="blur"
                      className="object-cover transition-transform duration-[1.4s] ease-out group-hover:scale-[1.04]"
                      style={{ objectPosition: ind.image.focal }}
                    />
                  </div>
                  <div className="md:col-span-7 md:col-start-6">
                    <p className="t-eyebrow text-bone-50/60">
                      {ind.index} — {ind.name}
                    </p>
                    <h3 className="t-h2 mt-4 transition-colors group-hover:text-white">{ind.headline}</h3>
                    <p className="t-body mt-4 max-w-xl text-bone-50/60">{ind.summary}</p>
                    <span className="mt-6 inline-flex items-center gap-2 text-[0.9375rem] font-medium">
                      <span className="border-b border-bone-50/30 pb-0.5 transition-colors group-hover:border-bone-50">Explore {ind.name.toLowerCase()}</span>
                      <span aria-hidden="true" className="transition-transform duration-300 group-hover:translate-x-1">
                        →
                      </span>
                    </span>
                  </div>
                </Link>
              </Reveal>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="engage-title" className="surface-light py-28 md:py-36">
        <div className="shell">
          <SectionHeading
            id="engage-title"
            eyebrow="How engagements will work"
            tone="light"
            title="Fully managed, end to end."
            body="Customers won't need to buy aircraft, train pilots, or learn new software. Our service model is designed around four steps."
          />
          <ol className="mt-14 grid gap-px overflow-hidden rounded-[3px] border border-ink-900/10 bg-ink-900/10 md:grid-cols-4">
            {engagement.map(([k, v], i) => (
              <li key={k} className="bg-bone-100 p-6 md:p-8">
                <p className="t-mono text-ink-900/60">0{i + 1}</p>
                <h3 className="t-h4 mt-4">{k}</h3>
                <p className="t-small mt-2 text-ink-900/65">{v}</p>
              </li>
            ))}
          </ol>
          <div className="mt-14 flex flex-col gap-3 sm:flex-row">
            <ButtonLink href="/contact?intent=demo" variant="dark">
              Become an early partner
            </ButtonLink>
          </div>
        </div>
      </section>
    </>
  );
}
