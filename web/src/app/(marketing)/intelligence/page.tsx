import type { Metadata } from "next";
import Link from "next/link";
import { PageHero, SectionHeading } from "@/components/layout/page-hero";
import { HeroMedia } from "@/components/media/hero-media";
import { IntelligenceDemo } from "@/components/viz/intelligence-demo";
import { ChangeDetection } from "@/components/viz/change-detection";
import { MosaicDemo } from "@/components/viz/mosaic-demo";
import { SampleReport } from "@/components/viz/sample-report";
import { ButtonLink } from "@/components/ui/button";
import { MediaNote, StatusTag } from "@/components/ui/primitives";
import { Reveal } from "@/components/ui/reveal";
import { media, video } from "@/content/media";

export const metadata: Metadata = {
  title: "Aerial Analysis",
  description:
    "SensorDyme aerial analysis — the computer vision and geospatial work in development for SensorDyme Aero: object detection, segmentation, geospatial mapping, temporal change detection, and reporting.",
  alternates: { canonical: "/intelligence" },
};

const capabilities = [
  { id: "detection", n: "01", name: "Object detection" },
  { id: "segmentation", n: "02", name: "Image segmentation" },
  { id: "mapping", n: "03", name: "Geospatial mapping" },
  { id: "change", n: "04", name: "Temporal change detection" },
  { id: "reporting", n: "05", name: "Intelligence reporting" },
];

export default function IntelligencePage() {
  return (
    <>
      <PageHero
        eyebrow="SensorDyme · Aerial analysis"
        title={
          <span className="uppercase">
            Every frame.
            <br />
            More intelligence.
          </span>
        }
        lead="SensorDyme applied to aerial imagery — computer vision and geospatial analysis designed to turn what Aero captures into detections, maps, measurements, and change over time."
        media={<HeroMedia poster={media.flyoverPoster.src} alt={media.flyoverPoster.alt} video={video.flyover} className="-z-10 [&_img]:brightness-75" />}
        credit="Aerial footage: Marco López / Mixkit"
      >
        <StatusTag>Research & development</StatusTag>
      </PageHero>

      <nav aria-label="Capabilities" className="sticky top-0 z-30 border-b border-bone-50/[0.08] bg-ink-950/85 backdrop-blur-xl">
        <div className="shell no-scrollbar flex gap-1 overflow-x-auto">
          {capabilities.map((c) => (
            <Link key={c.id} href={`#${c.id}`} className="flex shrink-0 items-baseline gap-2 px-3 py-4 text-[0.875rem] text-bone-50/60 transition-colors first:pl-0 hover:text-bone-50">
              <span className="t-mono text-bone-50/55">{c.n}</span>
              {c.name}
            </Link>
          ))}
        </div>
      </nav>

      <section id="detection" aria-labelledby="det-title" className="scroll-mt-16 bg-ink-900 py-28 md:py-36">
        <div className="shell">
          <SectionHeading
            id="det-title"
            index="01"
            eyebrow="Object detection"
            title="Find what matters in every image."
            body="Detection models locate and label objects — equipment, vehicles, structures, materials — so a site can be understood at a glance and tracked over time."
          />
          <Reveal className="mt-14 md:mt-20">
            <IntelligenceDemo only={["construction"]} initial="construction" />
          </Reveal>
        </div>
      </section>

      <section id="segmentation" aria-labelledby="seg-title" className="scroll-mt-16 border-t border-bone-50/[0.06] bg-ink-900 py-28 md:py-36">
        <div className="shell">
          <SectionHeading
            id="seg-title"
            index="02"
            eyebrow="Image segmentation"
            title="Every pixel, classified."
            body="Segmentation divides imagery into meaningful regions — healthy and stressed vegetation, water, bare soil, built surfaces — producing maps that can be measured."
          />
          <Reveal className="mt-14 md:mt-20">
            <IntelligenceDemo only={["agriculture", "landcover", "flood"]} initial="landcover" />
          </Reveal>
        </div>
      </section>

      <section id="mapping" aria-labelledby="map-title" className="scroll-mt-16 bg-ink-950 py-28 md:py-36">
        <div className="shell grid gap-12 lg:grid-cols-12 lg:items-center">
          <div className="lg:col-span-4">
            <SectionHeading id="map-title" index="03" eyebrow="Geospatial mapping" title="Images become maps." className="!block" />
            <p className="t-body mt-6 text-bone-50/65">
              Hundreds of overlapping photographs are aligned using their position and orientation, then stitched into a single georeferenced mosaic. Every finding is tied to real coordinates — so it can be measured, revisited, and shared.
            </p>
            <ul className="mt-8 space-y-3 border-t border-bone-50/10 pt-6">
              {["Orthomosaic generation", "Coordinate reference & scale", "Map layers for findings", "Exports for GIS tools"].map((x) => (
                <li key={x} className="flex items-center gap-3 text-[0.9375rem] text-bone-50/75">
                  <span aria-hidden="true" className="h-px w-3 bg-bone-50/40" />
                  {x}
                </li>
              ))}
            </ul>
          </div>
          <Reveal className="lg:col-span-8">
            <MosaicDemo />
          </Reveal>
        </div>
      </section>

      <section id="change" aria-labelledby="change-title" className="scroll-mt-16 border-t border-bone-50/[0.06] bg-ink-950 py-28 md:py-36">
        <div className="shell">
          <SectionHeading
            id="change-title"
            index="04"
            eyebrow="Temporal change detection"
            title="See what changed between visits."
            body="Repeat captures of the same area, compared pixel by pixel, show where things are growing, shrinking, or moving. Below: a real example computed from public satellite data."
          />
          <Reveal className="mt-14 md:mt-20">
            <ChangeDetection />
          </Reveal>
        </div>
      </section>

      <section id="reporting" aria-labelledby="report-title" className="scroll-mt-16 surface-light py-28 md:py-36">
        <div className="shell">
          <SectionHeading
            id="report-title"
            index="05"
            eyebrow="Intelligence reporting"
            tone="light"
            title="Findings people can act on."
            body="Analysis ends with a clear document: what we found, where, how important it is, and what to do next. Every finding is reviewed by a person before it is reported."
          />
          <Reveal className="mt-14 md:mt-20">
            <SampleReport />
          </Reveal>
          <MediaNote className="mt-10 text-center">Sample report layout. Property, findings, and figures are illustrative.</MediaNote>
        </div>
      </section>

      <section className="bg-ink-950 py-24 md:py-32">
        <div className="shell flex flex-col items-start justify-between gap-8 md:flex-row md:items-end">
          <div>
            <p className="t-eyebrow text-bone-50/50">Next</p>
            <h2 className="t-h2 mt-4 max-w-2xl">See how findings reach operators and customers.</h2>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <ButtonLink href="/platform">Command & Portal</ButtonLink>
            <ButtonLink href="/contact?intent=demo" variant="secondary">
              Talk to the team
            </ButtonLink>
          </div>
        </div>
      </section>
    </>
  );
}
