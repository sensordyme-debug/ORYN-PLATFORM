import type { Metadata } from "next";
import Link from "next/link";
import { PageHero, SectionHeading } from "@/components/layout/page-hero";
import { ArchitectureDiagram } from "@/components/tech/architecture-diagram";
import { ButtonLink, TextLink } from "@/components/ui/button";
import { Eyebrow, StatusTag } from "@/components/ui/primitives";
import { Reveal } from "@/components/ui/reveal";
import { media } from "@/content/media";
import { edgeLoop, pillars, platforms, principles } from "@/content/technology";

export const metadata: Metadata = {
  title: "Technology",
  description:
    "The architecture behind SensorDyme: one intelligence layer — perceive, track, add context, verify, act — running on the SensorDyme Edge prototype today and being developed for aerial capture with SensorDyme Aero.",
  alternates: { canonical: "/technology" },
};

const compute = [
  {
    where: "On the device",
    items: ["Detection on the neural accelerator (Edge)", "Tracking, zones & verification (Edge)", "Stabilization & navigation (Aero)", "Onboard inference (Aero, future)"],
  },
  {
    where: "In the cloud",
    items: ["Quality checks", "Orthomosaic processing", "Model inference", "Change comparison"],
  },
  {
    where: "With people",
    items: ["Mission authorization", "Finding review", "Context & notes", "Customer communication"],
  },
];

export default function TechnologyPage() {
  return (
    <>
      <PageHero
        eyebrow="Technology"
        title="The architecture of SensorDyme."
        lead="One intelligence layer — perceive, track, add context, verify, act — running on a fixed edge device today, and being developed for the air."
        image={media.techHero}
        credit="Photo: Louei Mups / Unsplash"
      />

      <section aria-labelledby="layers-title" className="bg-ink-950 py-28 md:py-36">
        <div className="shell">
          <SectionHeading
            id="layers-title"
            index="01"
            eyebrow="System architecture"
            title="One intelligence. Two vantage points."
            body="SensorDyme is the intelligence layer. Edge gives it a fixed post; Aero is being developed to give it altitude. ORYN's operations software sits around the aerial work."
          />
          <ul className="mt-14 grid gap-px overflow-hidden rounded-[3px] border border-bone-50/10 bg-bone-50/10 sm:grid-cols-2 xl:grid-cols-4">
            {platforms.map((p, i) => (
              <li key={p.id} className={i === 2 ? "bg-ink-900" : "bg-ink-950"}>
                <Link href={p.href} className="group flex h-full flex-col p-6 transition-colors hover:bg-bone-50/[0.03] md:p-8">
                  <p className="t-mono text-bone-50/55">{p.role}</p>
                  <h3 className="t-h4 mt-8">{p.name}</h3>
                  <p className="t-small mt-3 text-bone-50/60">{p.body}</p>
                  <div className="mt-auto flex items-center justify-between gap-4 pt-6">
                    <StatusTag tone={p.status === "Working prototype" ? "signal" : "neutral"}>{p.status}</StatusTag>
                    <span aria-hidden="true" className="text-bone-50/50 transition-transform group-hover:translate-x-1 group-hover:text-bone-50">→</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          <div className="mt-20 md:mt-28">
            <div className="flex flex-wrap items-baseline justify-between gap-4">
              <h3 className="t-h3">On the device: SensorDyme Edge</h3>
              <p className="t-mono text-bone-50/55">Runs on the prototype · no cloud round-trip</p>
            </div>
            <ol className="mt-6 grid gap-px overflow-hidden rounded-[3px] border border-bone-50/10 bg-bone-50/10 sm:grid-cols-2 lg:grid-cols-7">
              {edgeLoop.map((n, i) => (
                <li key={n.label} className="relative bg-ink-950 p-4 md:p-5">
                  <span className="t-mono text-bone-50/55">{String(i + 1).padStart(2, "0")}</span>
                  <p className="mt-2 text-[0.9375rem] font-medium leading-snug">{n.label}</p>
                  <p className="t-small mt-1 text-bone-50/50">{n.body}</p>
                  {i < edgeLoop.length - 1 ? (
                    <span aria-hidden="true" className="absolute -right-[7px] top-1/2 z-10 hidden size-3 -translate-y-1/2 rotate-45 border-r border-t border-signal bg-ink-950 lg:block" />
                  ) : null}
                </li>
              ))}
            </ol>
            <p className="t-mono mt-4 text-[0.6875rem] text-bone-50/55">
              Jupiter, SensorDyme&apos;s reasoning layer, turns plain-language requests into validated rules (in development). It does not sit in the real-time loop.
            </p>
          </div>
        </div>
      </section>

      <section aria-labelledby="arch-title" className="border-t border-bone-50/[0.06] bg-ink-900 py-28 md:py-36">
        <div className="shell">
          <SectionHeading
            id="arch-title"
            index="02"
            eyebrow="In the air: SensorDyme Aero"
            title="From flight to finding."
            body="The planned aerial pipeline: six stages, each with defined inputs and outputs. Select a stage to see what it does and where it runs."
          />
          <Reveal className="mt-14 md:mt-20">
            <ArchitectureDiagram />
          </Reveal>
        </div>
      </section>

      <section aria-labelledby="compute-title" className="border-t border-bone-50/[0.06] bg-ink-900 pb-28 md:pb-36">
        <div className="shell">
          <SectionHeading
            id="compute-title"
            index="03"
            eyebrow="Where work happens"
            title="Device, cloud, and people."
            body="Time-critical work stays on the device. Heavy aerial processing runs in the cloud. Judgment stays with trained people."
          />
          <div className="mt-14 grid gap-px overflow-hidden rounded-[3px] border border-bone-50/10 bg-bone-50/10 md:grid-cols-3">
            {compute.map((c, i) => (
              <Reveal key={c.where} delay={i * 0.08} className="bg-ink-950 p-6 md:p-8">
                <p className="t-mono text-bone-50/55">{String(i + 1).padStart(2, "0")}</p>
                <h3 className="t-h4 mt-3">{c.where}</h3>
                <ul className="mt-6 space-y-2.5">
                  {c.items.map((x) => (
                    <li key={x} className="flex items-center gap-3 text-[0.9375rem] text-bone-50/70">
                      <span aria-hidden="true" className="h-px w-3 bg-bone-50/40" />
                      {x}
                    </li>
                  ))}
                </ul>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section aria-labelledby="direction-title" className="bg-ink-950 py-28 md:py-36">
        <div className="shell">
          <SectionHeading
            id="direction-title"
            index="04"
            eyebrow="Development direction"
            title="Five commitments shape everything we build."
            body="ORYN is early. These are the directions our engineering is organized around — with an honest label on where each one stands."
          />
          <ol className="mt-16 border-t border-bone-50/10">
            {pillars.map((p, i) => (
              <Reveal as="li" key={p.id} className="grid gap-4 border-b border-bone-50/10 py-8 md:grid-cols-12 md:items-baseline md:gap-x-8 md:gap-y-4 md:py-10">
                <span className="t-mono text-bone-50/55 md:col-span-1">{String(i + 1).padStart(2, "0")}</span>
                <h3 className="t-h3 md:col-span-4">{p.name}</h3>
                <p className="t-body text-bone-50/65 md:col-span-7 xl:col-span-5">{p.body}</p>
                <div className="md:col-span-7 md:col-start-6 xl:col-span-2 xl:col-start-auto xl:text-right">
                  <StatusTag>{p.status}</StatusTag>
                </div>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>

      <section aria-labelledby="principles-title" className="surface-light py-28 md:py-36">
        <div className="shell">
          <SectionHeading
            id="principles-title"
            index="05"
            eyebrow="Engineering principles"
            title="Credibility is a design requirement."
            tone="light"
          />
          <div className="mt-14 grid gap-px overflow-hidden rounded-[3px] border border-ink-900/10 bg-ink-900/10 md:grid-cols-2">
            {principles.map((p) => (
              <div key={p.title} className="bg-bone-100 p-8 md:p-10">
                <h3 className="t-h4">{p.title}</h3>
                <p className="t-body mt-3 max-w-md text-ink-900/65">{p.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section aria-labelledby="explore-title" className="bg-ink-950 py-28 md:py-36">
        <div className="shell">
          <Eyebrow>Explore the system</Eyebrow>
          <h2 id="explore-title" className="t-h2 mt-6 max-w-3xl">
            One intelligence layer. One integrated system.
          </h2>
          <div className="mt-14 grid gap-px overflow-hidden border-y border-bone-50/10 md:grid-cols-3">
            {[
              { name: "SensorDyme Edge", body: "Intelligent sensing, on the device.", href: "/edge" },
              { name: "SensorDyme Aero", body: "The aerial development platform.", href: "/aero" },
              { name: "Command & Portal", body: "Operations and customer delivery.", href: "/platform" },
            ].map((x) => (
              <div key={x.href} className="flex flex-col justify-between gap-10 py-8 md:border-r md:border-bone-50/10 md:px-8 md:first:pl-0 md:last:border-r-0">
                <div>
                  <h3 className="t-h4">{x.name}</h3>
                  <p className="t-small mt-2 text-bone-50/55">{x.body}</p>
                </div>
                <TextLink href={x.href}>Learn more</TextLink>
              </div>
            ))}
          </div>
          <div className="mt-14">
            <ButtonLink href="/contact?intent=demo">Talk to the team</ButtonLink>
          </div>
        </div>
      </section>
    </>
  );
}
