import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHero, SectionHeading } from "@/components/layout/page-hero";
import { IntelligenceDemo } from "@/components/viz/intelligence-demo";
import { ButtonLink } from "@/components/ui/button";
import { MediaNote, StatusTag } from "@/components/ui/primitives";
import { Reveal } from "@/components/ui/reveal";
import { getIndustry, industries } from "@/content/industries";

export function generateStaticParams() {
  return industries.map((i) => ({ slug: i.slug }));
}

export const dynamicParams = false;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const ind = getIndustry(slug);
  if (!ind) return {};
  return {
    title: `${ind.name} — Solutions`,
    description: ind.summary,
    alternates: { canonical: `/solutions/${ind.slug}` },
    openGraph: { title: `${ind.name} — ORYN`, description: ind.summary },
  };
}

export default async function IndustryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ind = getIndustry(slug);
  if (!ind) notFound();
  const others = industries.filter((i) => i.slug !== ind.slug);

  return (
    <>
      <PageHero
        eyebrow={`Solutions · ${ind.index} — ${ind.name}`}
        title={ind.headline}
        lead={ind.intro}
        image={ind.image}
        credit={ind.image.credit}
      >
        <StatusTag className="max-w-full whitespace-normal">{ind.status.split(" — ")[0]}</StatusTag>
      </PageHero>

      <section aria-labelledby="challenge-title" className="bg-ink-950 py-28 md:py-36">
        <div className="shell grid gap-10 md:grid-cols-12">
          <div className="md:col-span-5">
            <p className="t-eyebrow text-bone-50/50">The challenge</p>
            <h2 id="challenge-title" className="t-h2 mt-4">
              {ind.challenge.title}
            </h2>
          </div>
          <p className="t-lead text-bone-50/70 md:col-span-6 md:col-start-7">{ind.challenge.body}</p>
        </div>
      </section>

      <section aria-labelledby="outputs-title" className="border-t border-bone-50/[0.06] bg-ink-950 pb-28 md:pb-36">
        <div className="shell pt-20">
          <SectionHeading id="outputs-title" eyebrow="What ORYN is designed to deliver" title="Intelligence, not just imagery." />
          <div className="mt-14 grid gap-px overflow-hidden rounded-[3px] border border-bone-50/10 bg-bone-50/10 md:grid-cols-2">
            {ind.outputs.map((o, i) => (
              <Reveal key={o.title} delay={(i % 2) * 0.06} className="bg-ink-950 p-8 md:p-10">
                <p className="t-mono text-bone-50/55">0{i + 1}</p>
                <h3 className="t-h4 mt-4">{o.title}</h3>
                <p className="t-body mt-2 text-bone-50/60">{o.body}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <Reveal>
        <div className="relative aspect-[4/3] w-full overflow-hidden md:aspect-[21/9]">
          <Image
            src={ind.secondaryImage.src}
            alt={ind.secondaryImage.alt}
            fill
            sizes="100vw"
            placeholder="blur"
            className="object-cover"
            style={{ objectPosition: ind.secondaryImage.focal }}
          />
        </div>
        <div className="shell">
          <MediaNote className="mt-3">{ind.secondaryImage.credit}</MediaNote>
        </div>
      </Reveal>

      <section aria-labelledby="questions-title" className="bg-ink-950 py-28 md:py-36">
        <div className="shell">
          <p className="t-eyebrow text-bone-50/50">Questions we aim to answer</p>
          <h2 id="questions-title" className="sr-only">
            Questions we aim to answer
          </h2>
          <ul className="mt-10 space-y-6 md:space-y-8">
            {ind.questions.map((q, i) => (
              <Reveal as="li" key={q} delay={i * 0.08} className="t-h2 max-w-4xl text-balance text-bone-50/90">
                <span className="text-bone-50/30">“</span>
                {q}
                <span className="text-bone-50/30">”</span>
              </Reveal>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="demo-title" className="border-t border-bone-50/[0.06] bg-ink-900 py-28 md:py-36">
        <div className="shell">
          <SectionHeading
            id="demo-title"
            eyebrow="Analysis example"
            title="What the analysis looks like."
            body="An illustrative example of the kind of output SensorDyme is being designed to produce. Drag the frame to compare."
          />
          <div className="mt-14">
            <IntelligenceDemo only={[ind.demo]} initial={ind.demo} />
          </div>
        </div>
      </section>

      <section aria-labelledby="status-title" className="surface-light py-24 md:py-32">
        <div className="shell grid gap-10 md:grid-cols-12">
          <div className="md:col-span-5">
            <p className="t-eyebrow text-ink-900/60">Where this stands</p>
            <h2 id="status-title" className="t-h3 mt-4">
              Honest about our stage.
            </h2>
          </div>
          <div className="md:col-span-6 md:col-start-7">
            <p className="t-lead text-ink-900/75">{ind.status}</p>
            <p className="t-body mt-4 text-ink-900/60">
              We&apos;re looking for early partners in {ind.name.toLowerCase()} who want to help shape these workflows around real needs.
            </p>
            <div className="mt-8">
              <ButtonLink href="/contact?intent=demo" variant="dark">
                Talk to us about {ind.name.toLowerCase()}
              </ButtonLink>
            </div>
          </div>
        </div>
      </section>

      <nav aria-label="Other industries" className="bg-ink-950 py-20 md:py-28">
        <div className="shell">
          <p className="t-eyebrow text-bone-50/50">Other applications</p>
          <ul className="mt-8 grid gap-px overflow-hidden border-y border-bone-50/10 sm:grid-cols-2 lg:grid-cols-4">
            {others.map((o) => (
              <li key={o.slug}>
                <Link href={`/solutions/${o.slug}`} className="group block py-6 sm:px-6 sm:first:pl-0">
                  <span className="t-mono text-bone-50/55">{o.index}</span>
                  <span className="mt-2 block text-[1.125rem] font-medium">{o.name}</span>
                  <span className="t-small mt-1 block text-bone-50/50 transition-colors group-hover:text-bone-50/80">{o.headline}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </nav>
    </>
  );
}
