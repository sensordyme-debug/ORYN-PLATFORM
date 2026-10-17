import type { Metadata } from "next";
import { PageHero, SectionHeading } from "@/components/layout/page-hero";
import { CommandPreview } from "@/components/previews/command-preview";
import { PortalPreview } from "@/components/previews/portal-preview";
import { ButtonLink } from "@/components/ui/button";
import { MediaNote, StatusTag } from "@/components/ui/primitives";
import { Reveal } from "@/components/ui/reveal";
import { media } from "@/content/media";

export const metadata: Metadata = {
  title: "Command & Portal",
  description:
    "ORYN Command is the planned operations platform for fleet, missions, processing and review. ORYN Portal is the planned customer dashboard. Explore interactive previews.",
  alternates: { canonical: "/platform" },
};

const commandFeatures = [
  ["Fleet management", "Aircraft readiness, battery and maintenance state, link health."],
  ["Mission operations", "Survey areas, flight plans, records, and track replay."],
  ["Processing pipeline", "Every capture tracked from upload to delivery."],
  ["Review queue", "Model outputs routed to analysts with confidence context."],
  ["Map layers", "Imagery, analysis, and terrain layers in one geospatial view."],
  ["Audit trail", "Who reviewed what, when — for every reported finding."],
];

const portalFeatures = [
  ["Plain-language findings", "What we found, where, and why it matters."],
  ["Simple maps", "Your property or site, with areas of interest marked."],
  ["History", "See how conditions have changed across inspections."],
  ["Reports & exports", "Download reports; export data for your own tools."],
  ["Request inspections", "Ask for a new flight without any technical setup."],
  ["Shared access", "Invite agronomists, managers, or consultants."],
];

export default function PlatformPage() {
  return (
    <>
      <PageHero
        eyebrow="ORYN Command & ORYN Portal"
        title="Two views of the same intelligence."
        lead="Command is where ORYN runs operations. Portal is where customers get answers. Both are in development — explore interactive previews built with sample data."
        image={media.stepAnalyze}
        credit="Photo: Sou Jest / Unsplash"
      >
        <StatusTag>In development</StatusTag>
      </PageHero>

      <section id="command" aria-labelledby="command-title" className="scroll-mt-20 bg-ink-950 py-28 md:py-36">
        <div className="shell">
          <SectionHeading
            id="command-title"
            index="01"
            eyebrow="ORYN Command"
            title="One platform. Total visibility."
            body="Our internal operations platform for fleet management, mission operations, processing, and aerial intelligence review."
            aside={<StatusTag tone="signal">Interactive product preview</StatusTag>}
          />
          <Reveal className="mt-14 md:mt-20">
            <CommandPreview />
          </Reveal>
          <p className="t-mono mt-4 text-bone-50/60">
            Try it: switch missions, change map layers, open a finding, replay a flight track. Basemap: USGS public-domain imagery; all operational data is sample data.
          </p>
          <dl className="mt-16 grid gap-px overflow-hidden rounded-[3px] border border-bone-50/10 bg-bone-50/10 sm:grid-cols-2 lg:grid-cols-3">
            {commandFeatures.map(([k, v]) => (
              <div key={k} className="bg-ink-950 p-6 md:p-8">
                <dt className="t-h4">{k}</dt>
                <dd className="t-small mt-2 text-bone-50/60">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section id="portal" aria-labelledby="portal-title" className="scroll-mt-20 bg-bone-50 py-28 text-ink-900 md:py-36" style={{ colorScheme: "light" }}>
        <div className="shell">
          <SectionHeading
            id="portal-title"
            index="02"
            eyebrow="ORYN Portal"
            tone="light"
            title="Complex technology. Simple answers."
            body="The customer dashboard: built for farmers, site managers, and consultants — not drone operators. No telemetry, no jargon."
            aside={<StatusTag tone="light">Concept preview · Sample data</StatusTag>}
          />
          <Reveal className="mt-14 md:mt-20">
            <PortalPreview />
          </Reveal>
          <dl className="mt-16 grid gap-px overflow-hidden rounded-[3px] border border-ink-900/10 bg-ink-900/10 sm:grid-cols-2 lg:grid-cols-3">
            {portalFeatures.map(([k, v]) => (
              <div key={k} className="bg-paper p-6 md:p-8">
                <dt className="t-h4">{k}</dt>
                <dd className="t-small mt-2 text-ink-900/60">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section aria-labelledby="connect-title" className="bg-ink-900 py-28 md:py-36">
        <div className="shell grid gap-12 md:grid-cols-12">
          <div className="md:col-span-5">
            <p className="t-eyebrow text-bone-50/50">Architecture</p>
            <h2 id="connect-title" className="t-h2 mt-4">
              Built to connect.
            </h2>
          </div>
          <div className="t-body space-y-4 text-bone-50/65 md:col-span-6 md:col-start-7">
            <p>
              This website is the public face of ORYN. Command and Portal will run as separate, authenticated applications — on their own subdomains — sharing one data platform and one source of truth for every mission and finding.
            </p>
            <p>
              Until those applications are live, the previews on this page run entirely in your browser with clearly labeled sample data.
            </p>
            <MediaNote className="text-bone-50">Previews are illustrative interfaces and are not connected to a production backend.</MediaNote>
            <div className="pt-4">
              <ButtonLink href="/contact?intent=demo">Request a walkthrough</ButtonLink>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
