import type { Metadata } from "next";
import Image from "next/image";
import { PageHero, SectionHeading } from "@/components/layout/page-hero";
import { ButtonLink } from "@/components/ui/button";
import { MediaNote } from "@/components/ui/primitives";
import { Reveal } from "@/components/ui/reveal";
import { media } from "@/content/media";
import { team } from "@/content/team";

export const metadata: Metadata = {
  title: "About",
  description:
    "ORYN is an early-stage company building intelligent physical systems. SensorDyme, our perception and reasoning layer, powers SensorDyme Edge and the SensorDyme Aero development platform.",
  alternates: { canonical: "/about" },
};

const philosophy = [
  {
    title: "Integrated, not assembled.",
    body: "Hardware, software, and operations are designed together. The value is in how the pieces work as one system.",
  },
  {
    title: "Honest about maturity.",
    body: "We label what is in development, what is a concept, and what is proven. Credibility compounds; overstatement doesn't.",
  },
  {
    title: "Human judgment at the center.",
    body: "Automation finds candidates. People decide what matters and what gets reported.",
  },
  {
    title: "Built to be operated.",
    body: "Our customers shouldn't need to become drone experts. Every design decision serves a managed service.",
  },
];

const horizons = [
  {
    when: "Now",
    title: "Build the foundation",
    body: "Mature the SensorDyme Edge prototype, develop the Aero A1 platform and the core analysis pipeline, and build the first versions of Command and Portal.",
  },
  {
    when: "Next",
    title: "Prove it in the field",
    body: "Structured testing, then pilot programs with early partners under applicable aviation regulations.",
  },
  {
    when: "Long term",
    title: "An integrated ecosystem",
    body: "Purpose-built sensors and aircraft, SensorDyme intelligence, and managed operations — making physical-world intelligence as easy to use as any other business service.",
  },
];

export default function AboutPage() {
  return (
    <>
      <PageHero
        eyebrow="About ORYN"
        title={
          <span className="uppercase">
            Building a clearer picture
            <br />
            of our world.
          </span>
        }
        image={media.aboutEarth}
        credit="Photo: Dembee Tsogoo / Unsplash"
      />

      <section aria-labelledby="mission-title" className="bg-ink-950 py-28 md:py-40">
        <div className="shell">
          <p className="t-eyebrow text-bone-50/50">Our mission</p>
          <h2 id="mission-title" className="t-h2 mt-6 max-w-5xl text-balance">
            To build systems that see, understand, and act in the physical world — and make that intelligence accessible to every organization that needs it, without requiring them to understand the technology behind it.
          </h2>
        </div>
      </section>

      <section aria-labelledby="problem-title" className="border-t border-bone-50/[0.06] bg-ink-950 pb-28 md:pb-36">
        <div className="shell grid gap-12 pt-20 md:grid-cols-12">
          <div className="md:col-span-5">
            <p className="t-eyebrow text-bone-50/50">The problem</p>
            <h2 id="problem-title" className="t-h3 mt-4">
              The view from above is powerful. Getting it is hard.
            </h2>
          </div>
          <div className="t-body space-y-4 text-bone-50/65 md:col-span-6 md:col-start-7">
            <p>
              Farmers, builders, land managers, and response teams make decisions about large areas every day. Aerial imagery can show them what they can&apos;t see from the ground — but today, getting it means buying aircraft, training pilots, navigating regulations, and making sense of thousands of images.
            </p>
            <p>
              Most organizations don&apos;t want a drone program. They want answers. ORYN exists to close that gap: we handle the aircraft, the operations, and the analysis, and deliver intelligence people can act on.
            </p>
          </div>
        </div>
      </section>

      <section aria-labelledby="philosophy-title" className="surface-light py-28 md:py-36">
        <div className="shell">
          <SectionHeading id="philosophy-title" eyebrow="Technology philosophy" tone="light" title="How we think about building." />
          <div className="mt-14 grid gap-px overflow-hidden rounded-[3px] border border-ink-900/10 bg-ink-900/10 md:grid-cols-2">
            {philosophy.map((p, i) => (
              <div key={p.title} className="bg-bone-100 p-8 md:p-10">
                <p className="t-mono text-ink-900/60">0{i + 1}</p>
                <h3 className="t-h4 mt-4">{p.title}</h3>
                <p className="t-body mt-2 max-w-md text-ink-900/65">{p.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section aria-labelledby="culture-title" className="bg-ink-950 py-28 md:py-36">
        <div className="shell grid gap-12 md:grid-cols-12 md:items-center">
          <Reveal className="md:col-span-7">
            <div className="relative aspect-[4/3] overflow-hidden rounded-[2px]">
              <Image src={media.aboutWorkshop.src} alt={media.aboutWorkshop.alt} fill sizes="(min-width: 768px) 58vw, 100vw" placeholder="blur" className="object-cover" />
            </div>
            <MediaNote className="mt-3">Representative engineering workspace. Photo: ThisisEngineering / Unsplash</MediaNote>
          </Reveal>
          <div className="md:col-span-4 md:col-start-9">
            <p className="t-eyebrow text-bone-50/50">Culture</p>
            <h2 id="culture-title" className="t-h3 mt-4">
              Founder-driven. Engineering-led.
            </h2>
            <div className="t-body mt-5 space-y-4 text-bone-50/65">
              <p>ORYN is built by people who like to make things work — at the bench, in code, and in the field.</p>
              <p>We value first-principles thinking, careful testing, and writing down what we learn. Small team, high standards, long horizon.</p>
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="vision-title" className="border-t border-bone-50/[0.06] bg-ink-900 py-28 md:py-36">
        <div className="shell">
          <SectionHeading id="vision-title" eyebrow="Long-term vision" title="Where we're going." />
          <ol className="mt-14 grid gap-px overflow-hidden rounded-[3px] border border-bone-50/10 bg-bone-50/10 md:grid-cols-3">
            {horizons.map((h) => (
              <li key={h.when} className="bg-ink-900 p-8 md:p-10">
                <p className="t-eyebrow text-signal">{h.when}</p>
                <h3 className="t-h4 mt-4">{h.title}</h3>
                <p className="t-body mt-2 text-bone-50/60">{h.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section aria-labelledby="team-title" className="bg-ink-950 py-28 md:py-36">
        <div className="shell grid gap-12 md:grid-cols-12">
          <div className="md:col-span-5">
            <p className="t-eyebrow text-bone-50/50">Team</p>
            <h2 id="team-title" className="t-h2 mt-4">
              The people behind ORYN.
            </h2>
          </div>
          <div className="md:col-span-6 md:col-start-7">
            {team.length ? (
              <ul className="border-t border-bone-50/10">
                {team.map((m) => (
                  <li key={m.name} className="grid grid-cols-[1fr_auto] items-baseline gap-4 border-b border-bone-50/10 py-5">
                    <div>
                      <p className="text-[1.125rem] font-medium">{m.link ? <a href={m.link} className="hover:underline">{m.name}</a> : m.name}</p>
                      {m.focus ? <p className="t-small text-bone-50/50">{m.focus}</p> : null}
                    </div>
                    <p className="t-mono text-bone-50/55">{m.role}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="border-t border-bone-50/10 pt-6">
                <p className="t-lead text-bone-50/75">
                  ORYN is a founder-led company at the beginning of its journey. Team profiles will be shared here as the company grows.
                </p>
                <p className="t-body mt-4 text-bone-50/55">
                  If you&apos;re an engineer, operator, or researcher who wants to work on aircraft, computer vision, or geospatial software — we&apos;d like to hear from you.
                </p>
              </div>
            )}
            <div className="mt-10">
              <ButtonLink href="/contact">Get in touch</ButtonLink>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
