import Image from "next/image";
import { Hero } from "@/components/home/hero";
import { SensorDymeFamily } from "@/components/home/sensordyme-family";
import { SystemIntro } from "@/components/home/system-intro";
import { IndustriesStack } from "@/components/home/industries-stack";
import { ManagedSteps } from "@/components/home/managed-steps";
import { DroneExplorer } from "@/components/aero/drone-explorer";
import { PerceptionStory } from "@/components/edge/perception-story";
import { IntelligenceDemo } from "@/components/viz/intelligence-demo";
import { CommandPreview } from "@/components/previews/command-preview";
import { PortalPreview } from "@/components/previews/portal-preview";
import { ButtonLink, TextLink } from "@/components/ui/button";
import { Eyebrow, MediaNote, StatusTag } from "@/components/ui/primitives";
import { ChapterHeading } from "@/components/ui/chapter-heading";
import { Reveal } from "@/components/ui/reveal";
import { media } from "@/content/media";

export default function HomePage() {
  return (
    <>
      <Hero />

      <SensorDymeFamily />

      {/* ── SENSORDYME EDGE ───────────────────────────────── */}
      <section aria-labelledby="edge-title" className="border-t border-bone-50/[0.06] bg-ink-900 py-28 md:py-40">
        <div className="shell">
          <ChapterHeading
            id="edge-title"
            index="02"
            eyebrow="SensorDyme Edge"
            title={
              <>
                From pixels
                <br />
                to decisions.
              </>
            }
            body="Follow one moment through the system: what the camera sees, what SensorDyme understands, what it confirms — and what happens next. Detection, tracking, and verification all run on the device."
            aside={<StatusTag tone="signal">Working prototype</StatusTag>}
          />
          <div className="mt-14 md:mt-20">
            <PerceptionStory />
          </div>
          <div className="mt-14 flex justify-end">
            <TextLink href="/edge">Explore SensorDyme Edge</TextLink>
          </div>
        </div>
      </section>

      {/* ── SENSORDYME AERO ───────────────────────────────── */}
      <section aria-labelledby="aero-title" className="bg-ink-950 pb-28 pt-28 md:pb-40 md:pt-40">
        <div className="shell">
          <ChapterHeading
            id="aero-title"
            index="03"
            eyebrow="SensorDyme Aero"
            title={
              <>
                Engineered
                <br />
                to see more.
              </>
            }
            body="Designed to give SensorDyme intelligence altitude and mobility. Aero is a modular aerial development platform — airframe, propulsion, power, flight control, compute, and payload as independent modules, each one testable and replaceable."
            aside={<StatusTag>A1 · In development</StatusTag>}
          />
          <div className="mt-14 md:mt-20">
            <DroneExplorer idPrefix="home-aero" />
          </div>
          <div className="mt-14 grid gap-8 border-t border-bone-50/10 pt-8 md:grid-cols-12 md:items-end">
            <p className="t-body text-bone-50/65 md:col-span-6">
              We integrate proven components into our own architecture — then test, characterize, and document every module before anything is published as a specification.
            </p>
            <div className="md:col-span-4 md:col-start-9 md:text-right">
              <TextLink href="/aero">Explore SensorDyme Aero</TextLink>
            </div>
          </div>
        </div>
      </section>

      <SystemIntro index="04" />

      {/* ── ORYN INTELLIGENCE ─────────────────────────────── */}
      <section aria-labelledby="intel-title" className="border-t border-bone-50/[0.06] bg-ink-900 py-28 md:py-40">
        <div className="shell">
          <ChapterHeading
            id="intel-title"
            index="05"
            eyebrow="SensorDyme · Aerial analysis"
            title={
              <>
                Every frame.
                <br />
                More intelligence.
              </>
            }
            body="What SensorDyme is being developed to do with aerial imagery: turn it into maps, detections, and measurements. Drag the frame to compare."
          />
          <div className="mt-14 md:mt-20">
            <IntelligenceDemo />
          </div>
          <div className="mt-14 flex justify-end">
            <TextLink href="/intelligence">Explore aerial analysis</TextLink>
          </div>
        </div>
      </section>

      {/* ── ORYN COMMAND ──────────────────────────────────── */}
      <section aria-labelledby="command-title" className="relative overflow-hidden bg-ink-950 py-28 md:py-40">
        <div aria-hidden="true" className="tech-grid pointer-events-none absolute inset-0 text-bone-50 opacity-40 [mask-image:radial-gradient(ellipse_at_50%_30%,black,transparent_70%)]" />
        <div className="shell relative">
          <ChapterHeading
            id="command-title"
            index="06"
            eyebrow="ORYN Command"
            title={
              <>
                One platform.
                <br />
                Total visibility.
              </>
            }
            body="The operations layer behind every ORYN mission — aircraft, flights, processing, and findings in a single view."
            aside={<StatusTag tone="signal">Interactive product preview</StatusTag>}
          />

          <Reveal className="mt-14 md:mt-20">
            <CommandPreview />
          </Reveal>

          <div className="mt-6 grid gap-x-8 gap-y-6 border-b border-bone-50/10 pb-10 md:grid-cols-4">
            {[
              ["Fleet", "Aircraft readiness, maintenance, and link status."],
              ["Missions", "Planned survey areas, flight records, and replays."],
              ["Findings", "Detections routed through analyst review."],
              ["Layers", "Imagery, analysis, and terrain on one map."],
            ].map(([k, v]) => (
              <div key={k}>
                <p className="t-eyebrow text-bone-50/60">{k}</p>
                <p className="t-small mt-2 text-bone-50/70">{v}</p>
              </div>
            ))}
          </div>
          <div className="mt-8 flex flex-col justify-between gap-6 md:flex-row md:items-center">
            <MediaNote className="max-w-2xl">
              Illustrative interface with sample data. Basemap: USGS The National Map orthoimagery and 3DEP elevation (public domain), Grant County, Washington. Missions and findings are fictional.
            </MediaNote>
            <TextLink href="/platform#command">Discover ORYN Command</TextLink>
          </div>
        </div>
      </section>

      {/* ── INDUSTRIES ───────────────────────────────────── */}
      <section aria-labelledby="apps-title" className="bg-ink-950">
        <div className="shell py-28 md:py-40">
          <ChapterHeading
            id="apps-title"
            index="07"
            eyebrow="Applications"
            title={
              <>
                Built for the
                <br />
                ground truth.
              </>
            }
            body="Five areas where clear, repeatable aerial intelligence can change how decisions are made."
          />
        </div>
        <IndustriesStack />
      </section>

      {/* ── MANAGED EXPERIENCE ───────────────────────────── */}
      <section aria-labelledby="managed-title" className="surface-light py-28 md:py-40">
        <div className="shell">
          <ChapterHeading
            id="managed-title"
            index="08"
            eyebrow="The managed experience"
            tone="light"
            title={
              <>
                You focus on your work.
                <br />
                <span className="text-ink-900/60">We handle the intelligence.</span>
              </>
            }
            body="ORYN is designed as a fully managed service. You don't need to fly, maintain, or understand drones — we do that, and deliver the answers."
          />
          <div className="mt-16 md:mt-24">
            <ManagedSteps />
          </div>
        </div>
      </section>

      {/* ── ORYN PORTAL ──────────────────────────────────── */}
      <section aria-labelledby="portal-title" className="bg-bone-50 py-28 text-ink-900 md:py-40" style={{ colorScheme: "light" }}>
        <div className="shell">
          <ChapterHeading
            id="portal-title"
            index="09"
            eyebrow="ORYN Portal"
            tone="light"
            title={
              <>
                Complex technology.
                <br />
                Simple answers.
              </>
            }
            body="The customer view: no telemetry, no jargon. Just what changed, where, and what to do about it."
            aside={<StatusTag tone="light">Concept preview · Sample data</StatusTag>}
          />
          <Reveal className="mt-14 md:mt-20">
            <PortalPreview />
          </Reveal>

          <div className="mt-16 grid gap-px overflow-hidden rounded-[3px] border border-ink-900/10 bg-ink-900/10 md:mt-24 md:grid-cols-2">
            <div className="bg-ink-900 p-8 text-bone-50 md:p-10">
              <p className="t-eyebrow text-bone-50/50">ORYN Command</p>
              <p className="t-h4 mt-4">For ORYN operators and analysts.</p>
              <ul className="t-small mt-6 space-y-2 text-bone-50/65">
                <li>Fleet status, flight records, telemetry</li>
                <li>Processing pipelines and model outputs</li>
                <li>Confidence scores and analyst review</li>
              </ul>
            </div>
            <div className="bg-paper p-8 md:p-10">
              <p className="t-eyebrow text-ink-900/60">ORYN Portal</p>
              <p className="t-h4 mt-4">For the people who need answers.</p>
              <ul className="t-small mt-6 space-y-2 text-ink-900/65">
                <li>Plain-language findings and suggestions</li>
                <li>A simple map of your property or site</li>
                <li>Reports, history, and inspection requests</li>
              </ul>
            </div>
          </div>
          <div className="mt-10 flex justify-end">
            <TextLink href="/platform#portal">Explore ORYN Portal</TextLink>
          </div>
        </div>
      </section>

      {/* ── CLOSING CTA ──────────────────────────────────── */}
      <section aria-labelledby="cta-title" className="relative isolate overflow-hidden bg-ink-950">
        <Image
          src={media.contact.src}
          alt=""
          fill
          sizes="100vw"
          placeholder="blur"
          className="-z-10 object-cover opacity-70"
          style={{ objectPosition: media.contact.focal }}
        />
        <div aria-hidden="true" className="absolute inset-0 -z-[5] bg-gradient-to-b from-ink-950 via-ink-950/40 to-ink-950/80" />
        <div className="shell flex min-h-[80svh] flex-col justify-center py-32 text-center">
          <Eyebrow className="justify-center">Work with ORYN</Eyebrow>
          <h2 id="cta-title" className="t-h1 mx-auto mt-6 max-w-[14ch] uppercase">
            Let&apos;s see what&apos;s possible.
          </h2>
          <p className="t-lead mx-auto mt-6 max-w-xl text-bone-50/70">
            We&apos;re looking for early partners who want to shape how intelligent sensing — on the ground and in the air — works in their industry.
          </p>
          <div className="mt-10 flex flex-col justify-center gap-3 sm:flex-row">
            <ButtonLink href="/contact?intent=demo">Talk to the team</ButtonLink>
            <ButtonLink href="/technology" variant="secondary">
              See the system
            </ButtonLink>
          </div>
        </div>
      </section>
    </>
  );
}
