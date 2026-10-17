import type { Metadata } from "next";
import Link from "next/link";
import { SectionHeading } from "@/components/layout/page-hero";
import { AnnotatedBlueprint } from "@/components/aero/annotated-blueprint";
import { FlightControlDiagram } from "@/components/aero/flight-control-diagram";
import { DroneExplorer } from "@/components/aero/drone-explorer";
import { DroneBlueprint } from "@/components/viz/drone-blueprint";
import { ButtonLink } from "@/components/ui/button";
import { Eyebrow, MediaNote, StatusTag } from "@/components/ui/primitives";
import { Reveal } from "@/components/ui/reveal";
import { a1Specs, roadmap, sensorDirection } from "@/content/aero";
import { cn } from "@/lib/cn";

export const metadata: Metadata = {
  title: "SensorDyme Aero",
  description:
    "SensorDyme Aero is the aerial extension of SensorDyme intelligence. A1 is the modular development aircraft we are building to integrate, test, and characterize it.",
  alternates: { canonical: "/aero" },
};

const philosophy = [
  {
    title: "Integrate, then characterize.",
    body: "We start from proven components — motors, flight controllers, sensors — and invest our effort in how they work together. Each module is bench-tested and documented before integration.",
  },
  {
    title: "Designed for the field.",
    body: "Survey work means repetition. The airframe is designed around fast inspection, battery swaps, and replacing a damaged arm in minutes rather than hours.",
  },
  {
    title: "Sensing defines the aircraft.",
    body: "Payload requirements drive everything else: power budget, flight time, stability. We size the aircraft around the data we need to collect.",
  },
];

const vantage = [
  { k: "Point of view", edge: "Fixed, at eye level", aero: "Mobile, from above" },
  { k: "Coverage", edge: "One room, yard, or vehicle", aero: "Large or hard-to-reach areas" },
  { k: "Intelligence", edge: "SensorDyme, on the device", aero: "SensorDyme, intended onboard" },
  { k: "Status", edge: "Working prototype", aero: "Concept · development platform" },
];

const exploring = [
  { name: "Environmental intelligence", href: "/solutions/environment" },
  { name: "Disaster assessment", href: "/solutions/disaster-response" },
  { name: "Agricultural monitoring", href: "/solutions/agriculture" },
  { name: "Construction monitoring", href: "/solutions/construction" },
  { name: "Search & rescue", href: "/solutions/search-and-rescue" },
  { name: "Infrastructure inspection", href: null },
];

const phaseStyle: Record<(typeof roadmap)[number]["state"], string> = {
  complete: "bg-bone-50 border-bone-50",
  current: "bg-signal border-signal",
  next: "bg-transparent border-bone-50/60",
  future: "bg-transparent border-bone-50/25",
};
const phaseLabel: Record<(typeof roadmap)[number]["state"], string> = {
  complete: "Complete",
  current: "In progress",
  next: "Next",
  future: "Planned",
};

export default function AeroPage() {
  return (
    <>
      {/* Product hero */}
      <section aria-labelledby="aero-hero" className="relative isolate overflow-hidden bg-ink-950 pt-[calc(var(--header-h)+3rem)]">
        <div aria-hidden="true" className="tech-grid absolute inset-0 -z-10 text-bone-50 opacity-50 [mask-image:radial-gradient(ellipse_at_65%_45%,black,transparent_70%)]" />
        <div className="shell grid gap-10 pb-16 lg:min-h-[calc(100svh-var(--header-h)-3rem)] lg:grid-cols-12 lg:items-center lg:pb-10">
          <div className="lg:col-span-5">
            <Eyebrow className="animate-[fade_1.2s_var(--ease-out-expo)_0.2s_both]">SensorDyme Aero</Eyebrow>
            <h1 id="aero-hero" className="t-display mt-6 animate-[fade_1.4s_var(--ease-out-expo)_0.3s_both] uppercase">
              Aero.
            </h1>
            <p className="t-h3 mt-6 max-w-md animate-[fade_1.4s_var(--ease-out-expo)_0.45s_both] text-bone-50/85">SensorDyme, given altitude.</p>
            <p className="t-body mt-5 max-w-md animate-[fade_1.4s_var(--ease-out-expo)_0.55s_both] text-bone-50/60">
              SensorDyme Aero is the aerial extension of SensorDyme intelligence. A1 is the development aircraft we are building to integrate, test, and characterize it — a modular multirotor designed around high-quality aerial data capture.
            </p>
            <div className="mt-8 flex animate-[fade_1.4s_var(--ease-out-expo)_0.65s_both] flex-wrap items-center gap-4">
              <StatusTag tone="signal">A1 · In development</StatusTag>
              <StatusTag>Concept drawing</StatusTag>
            </div>
          </div>
          <div className="lg:col-span-7">
            <DroneBlueprint className="mx-auto max-w-[760px]" />
          </div>
        </div>
      </section>

      <section aria-labelledby="overview-title" className="bg-ink-950 pb-28 md:pb-36">
        <div className="shell">
          <div className="grid gap-10 border-t border-bone-50/10 pt-14 md:grid-cols-12">
            <h2 id="overview-title" className="t-h3 md:col-span-5">
              A platform for learning fast — and building it right.
            </h2>
            <div className="t-body space-y-4 text-bone-50/65 md:col-span-6 md:col-start-7">
              <p>
                A1 is not a finished product. It is the engineering platform where we bring together airframe, propulsion, flight control, compute, and sensing — and learn what an aircraft purpose-built for managed aerial intelligence needs to be.
              </p>
              <p>
                Everything we learn from A1 informs the aircraft that will eventually fly ORYN missions. We will publish performance figures only once they are measured and validated.
              </p>
            </div>
          </div>
        </div>
        <div className="shell mt-20 md:mt-28">
          <DroneExplorer idPrefix="aero-page" />
        </div>
      </section>

      <section aria-labelledby="vantage-title" className="border-t border-bone-50/[0.06] bg-ink-900 py-28 md:py-36">
        <div className="shell">
          <SectionHeading
            id="vantage-title"
            eyebrow="Edge and Aero"
            title="Same intelligence. A new vantage point."
            body="SensorDyme Edge watches one place, continuously. Aero is designed to carry the same perceive–track–verify approach to places a fixed sensor cannot reach."
          />
          <div className="mt-14 overflow-hidden rounded-[3px] border border-bone-50/10">
            <div className="t-mono grid grid-cols-[1fr_1fr] border-b border-bone-50/10 bg-ink-950 text-bone-50/55 md:grid-cols-[1fr_1.4fr_1.4fr]">
              <span className="hidden px-5 py-3 md:block">Layer</span>
              <span className="px-5 py-3">SensorDyme Edge</span>
              <span className="border-l border-bone-50/10 px-5 py-3">SensorDyme Aero</span>
            </div>
            {vantage.map((r) => (
              <div key={r.k} className="grid grid-cols-[1fr_1fr] border-b border-bone-50/10 last:border-b-0 md:grid-cols-[1fr_1.4fr_1.4fr]">
                <span className="t-mono col-span-2 px-5 pt-4 text-bone-50/50 md:col-span-1 md:py-4">{r.k}</span>
                <span className="px-5 py-3 text-[0.9375rem] text-bone-50/85 md:py-4">{r.edge}</span>
                <span className="border-l border-bone-50/10 px-5 py-3 text-[0.9375rem] text-bone-50/85 md:py-4">{r.aero}</span>
              </div>
            ))}
          </div>
          <div className="mt-16">
            <p className="t-eyebrow text-bone-50/50">Exploring applications in</p>
            <ul className="mt-5 grid border-t border-bone-50/10 sm:grid-cols-2 lg:grid-cols-3">
              {exploring.map((x) => (
                <li key={x.name} className="border-b border-bone-50/10">
                  {x.href ? (
                    <Link href={x.href} className="group flex items-baseline justify-between gap-4 py-4 pr-4">
                      <span className="text-[1.0625rem] text-bone-50/85 transition-colors group-hover:text-bone-50">{x.name}</span>
                      <span aria-hidden="true" className="text-bone-50/40 transition-transform group-hover:translate-x-1 group-hover:text-bone-50">→</span>
                    </Link>
                  ) : (
                    <span className="flex items-baseline justify-between gap-4 py-4 pr-4">
                      <span className="text-[1.0625rem] text-bone-50/85">{x.name}</span>
                      <span className="t-mono text-bone-50/45">Exploratory</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <MediaNote className="mt-4">Intended applications. No SensorDyme Aero missions have been flown for customers.</MediaNote>
          </div>
        </div>
      </section>

      <section aria-labelledby="modules-title" className="border-t border-bone-50/[0.06] bg-ink-900 py-28 md:py-36">
        <div className="shell">
          <SectionHeading
            id="modules-title"
            index="01"
            eyebrow="Modular architecture"
            title="Six modules. Clear interfaces."
            body="Each module has a defined mechanical, electrical, and data interface — so it can be tested on its own and upgraded without redesigning the aircraft."
          />
          <div className="mt-16">
            <AnnotatedBlueprint detailed />
          </div>
        </div>
      </section>

      <section aria-labelledby="philosophy-title" className="bg-ink-950 py-28 md:py-36">
        <div className="shell">
          <SectionHeading id="philosophy-title" index="02" eyebrow="Integration philosophy" title="How we build hardware." />
          <div className="mt-16 grid gap-px overflow-hidden rounded-[3px] border border-bone-50/10 bg-bone-50/10 md:grid-cols-3">
            {philosophy.map((p, i) => (
              <Reveal key={p.title} delay={i * 0.08} className="bg-ink-950 p-6 md:p-8">
                <p className="t-mono text-bone-50/55">0{i + 1}</p>
                <h3 className="t-h3 mt-8 md:mt-16">{p.title}</h3>
                <p className="t-body mt-4 text-bone-50/65">{p.body}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section aria-labelledby="fc-title" className="border-t border-bone-50/[0.06] bg-ink-900 py-28 md:py-36">
        <div className="shell">
          <SectionHeading
            id="fc-title"
            index="03"
            eyebrow="Flight-control architecture"
            title="Keep the critical loop simple."
            body="A dedicated flight controller runs stabilization and navigation independently. Mission software runs on a separate companion computer and communicates through a narrow, well-defined interface."
          />
          <Reveal className="mt-14 md:mt-20">
            <FlightControlDiagram />
          </Reveal>
          <MediaNote className="mt-6">Planned architecture. Component selection is in progress.</MediaNote>
        </div>
      </section>

      <section aria-labelledby="sensors-title" className="bg-ink-950 py-28 md:py-36">
        <div className="shell">
          <SectionHeading
            id="sensors-title"
            index="04"
            eyebrow="Sensor compatibility"
            title="One mount. Many ways of seeing."
            body="The payload interface is intended to accept different sensors as the platform matures. Our current direction:"
          />
          <ul className="mt-14 border-t border-bone-50/10">
            {sensorDirection.map((s) => (
              <li key={s.name} className="grid gap-3 border-b border-bone-50/10 py-6 md:grid-cols-12 md:items-baseline md:gap-x-8 md:gap-y-3">
                <h3 className="t-h4 md:col-span-4">{s.name}</h3>
                <p className="t-body text-bone-50/60 md:col-span-8 xl:col-span-6">{s.body}</p>
                <div className="md:col-span-8 md:col-start-5 xl:col-span-2 xl:col-start-auto xl:text-right">
                  <StatusTag tone={s.status === "Initial focus" ? "signal" : "neutral"}>{s.status}</StatusTag>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="specs-title" className="surface-light py-28 md:py-36">
        <div className="shell">
          <SectionHeading
            id="specs-title"
            index="05"
            eyebrow="Specifications"
            tone="light"
            title="Measured, then published."
            body="We don't publish numbers we haven't measured. Specifications will appear here as they are validated through structured testing."
          />
          <dl className="mt-14 grid border-t border-ink-900/15 md:grid-cols-2 md:gap-x-16">
            {a1Specs.map((s) => (
              <div key={s.label} className="flex items-baseline justify-between gap-6 border-b border-ink-900/10 py-4">
                <dt className="text-[0.9375rem] text-ink-900/70">{s.label}</dt>
                <dd className="text-right">
                  {s.value ? (
                    <span className="text-[0.9375rem] font-medium">{s.value}</span>
                  ) : (
                    <span className="t-mono text-ink-900/60">To be established</span>
                  )}
                  {s.note ? <span className="t-mono block text-[0.6875rem] text-ink-900/60">{s.note}</span> : null}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section aria-labelledby="roadmap-title" className="bg-ink-950 py-28 md:py-36">
        <div className="shell">
          <SectionHeading
            id="roadmap-title"
            index="06"
            eyebrow="Development roadmap"
            title="Where Aero is headed."
            body="Phases are sequential in intent, but overlap in practice. Timing will be shared as milestones are reached."
          />
          <ol className="relative mt-16 grid gap-10 md:grid-cols-5 md:gap-6">
            <span aria-hidden="true" className="absolute bottom-0 left-[7px] top-0 w-px bg-bone-50/15 md:bottom-auto md:left-0 md:right-0 md:top-[7px] md:h-px md:w-auto" />
            {roadmap.map((p) => (
              <li key={p.id} className="relative pl-10 md:pl-0 md:pt-12">
                <span aria-hidden="true" className={cn("absolute left-0 top-1 size-[15px] rounded-full border md:top-0", phaseStyle[p.state])} />
                <p className="t-mono text-bone-50/60">
                  {p.label} · {phaseLabel[p.state]}
                </p>
                <h3 className="t-h4 mt-3">{p.title}</h3>
                <p className="t-small mt-3 text-bone-50/60">{p.body}</p>
              </li>
            ))}
          </ol>
          <div className="mt-20 flex flex-col items-start justify-between gap-8 border-t border-bone-50/10 pt-10 md:flex-row md:items-center">
            <p className="t-h4 max-w-xl text-bone-50/85">Interested in shaping the platform as an early partner?</p>
            <ButtonLink href="/contact?intent=demo">Talk to the team</ButtonLink>
          </div>
        </div>
      </section>
    </>
  );
}
