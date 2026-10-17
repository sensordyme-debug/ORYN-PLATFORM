import Link from "next/link";
import { DroneBlueprint } from "@/components/viz/drone-blueprint";
import { EdgeBlueprint } from "@/components/viz/edge-blueprint";
import { ChapterHeading } from "@/components/ui/chapter-heading";
import { StatusTag } from "@/components/ui/primitives";
import { Reveal } from "@/components/ui/reveal";
import { loop } from "@/content/sensordyme";

const products = [
  {
    href: "/edge",
    family: "Fixed · on site",
    name: "SensorDyme Edge",
    body: "An edge-AI unit that perceives, tracks, and confirms events on the device — and acts in the room.",
    status: "Working prototype",
    tone: "signal" as const,
    drawing: "Edge · blueprint",
    cta: "Explore Edge",
  },
  {
    href: "/aero",
    family: "Mobile · aerial",
    name: "SensorDyme Aero",
    body: "A modular aerial development platform that gives SensorDyme altitude, reach, and mobility.",
    status: "Concept · in development",
    tone: "neutral" as const,
    drawing: "Aero · concept drawing",
    cta: "Explore Aero",
  },
];

/** ORYN → SensorDyme → Edge | Aero, as one structure rather than a list. */
export function SensorDymeFamily() {
  return (
    <section id="sensordyme" aria-labelledby="sensordyme-title" className="scroll-mt-0 border-t border-bone-50/[0.06] bg-ink-950 py-28 md:py-40">
      <div className="shell">
        <ChapterHeading
          id="sensordyme-title"
          index="01"
          eyebrow="SensorDyme"
          title={
            <>
              One intelligence.
              <br />
              Two vantage points.
            </>
          }
          body="SensorDyme is the perception and reasoning layer ORYN builds into its products. It sees, understands, and verifies before it acts — on site with Edge, and in development for the air with Aero."
        />

        <Reveal className="mt-16 md:mt-24">
          <div className="grid gap-px overflow-hidden rounded-[3px] border border-bone-50/10 bg-bone-50/10">
            <div className="t-mono flex flex-wrap items-center justify-between gap-2 bg-ink-950 px-5 py-3 text-bone-50/55 md:px-8">
              <span>ORYN · Company</span>
              <span className="hidden sm:inline">Intelligent physical systems</span>
            </div>

            <div className="bg-ink-900 px-5 py-6 md:px-8 md:py-8">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <p className="t-h4">SensorDyme</p>
                <p className="t-mono text-bone-50/55">Intelligence layer</p>
              </div>
              <ol className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4">
                {loop.map((l, i) => (
                  <li key={l.word} className="border-t border-bone-50/15 pt-3">
                    <p className="flex items-baseline gap-3">
                      <span className="t-mono text-bone-50/50">{String(i + 1).padStart(2, "0")}</span>
                      <span className="text-[1.0625rem] font-medium uppercase tracking-[0.02em]">{l.word}</span>
                    </p>
                    <p className="t-small mt-1.5 text-bone-50/55">{l.body}</p>
                  </li>
                ))}
              </ol>
            </div>

            <div className="grid gap-px bg-bone-50/10 md:grid-cols-2">
              {products.map((p) => (
                <Link key={p.href} href={p.href} className="group relative flex flex-col bg-ink-950 transition-colors hover:bg-ink-900">
                  <div className="relative aspect-[16/10] overflow-hidden border-b border-bone-50/[0.06]">
                    <div aria-hidden="true" className="tech-grid absolute inset-0 text-bone-50 opacity-25 [mask-image:radial-gradient(ellipse_at_50%_50%,black,transparent_70%)]" />
                    {/* Both products drawn in the same blueprint language */}
                    <div className="absolute inset-0 grid place-items-center p-6 md:p-10">
                      {p.href === "/edge" ? (
                        <EdgeBlueprint className="!h-full !w-full transition-transform duration-[1.2s] ease-out group-hover:scale-[1.03]" showCallouts={false} showTitleBlock={false} />
                      ) : (
                        <DroneBlueprint className="!h-full !w-full transition-transform duration-[1.2s] ease-out group-hover:scale-[1.03]" showCallouts={false} showTitleBlock={false} />
                      )}
                    </div>
                    <p className="t-mono absolute left-4 top-4 flex items-center gap-2 text-[0.6875rem] text-bone-50/55 md:left-5 md:top-5">
                      <span aria-hidden="true" className="size-1.5 rounded-full bg-signal" /> {p.drawing}
                    </p>
                  </div>
                  <div className="flex flex-1 flex-col gap-4 p-5 md:p-8">
                    <p className="t-mono text-bone-50/55">{p.family}</p>
                    <h3 className="t-h3">{p.name}</h3>
                    <p className="t-body max-w-md text-bone-50/60">{p.body}</p>
                    <div className="mt-auto flex flex-wrap items-center justify-between gap-4 pt-2">
                      <StatusTag tone={p.tone}>{p.status}</StatusTag>
                      <span className="inline-flex items-center gap-2 text-[0.9375rem] font-medium">
                        <span className="border-b border-bone-50/30 pb-0.5 transition-colors group-hover:border-bone-50">{p.cta}</span>
                        <span aria-hidden="true" className="transition-transform duration-300 group-hover:translate-x-0.5">→</span>
                      </span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
