import type { Metadata } from "next";
import { SectionHeading } from "@/components/layout/page-hero";
import { DeviceExplorer } from "@/components/edge/device-explorer";
import { EdgeExplorer } from "@/components/edge/edge-explorer";
import { PerceptionStory } from "@/components/edge/perception-story";
import { EdgeBlueprint } from "@/components/viz/edge-blueprint";
import { ButtonLink, TextLink } from "@/components/ui/button";
import { Eyebrow, MediaNote, StatusTag } from "@/components/ui/primitives";
import { Reveal } from "@/components/ui/reveal";
import { edgeMeasurements, edgeModes, edgeStatus, jupiter } from "@/content/sensordyme";
import { cn } from "@/lib/cn";

export const metadata: Metadata = {
  title: "SensorDyme Edge",
  description:
    "SensorDyme Edge is an edge-AI sensing unit that perceives, tracks, and verifies events on the device — and acts in the room when a rule is confirmed. Working prototype, in development.",
  alternates: { canonical: "/edge" },
};

/** Physical device → intelligence: what each layer contributes. */
const bridge = [
  { k: "Sensor", what: "Camera Module 3 · NoIR", does: "Captures the scene, day and night" },
  { k: "Inference", what: "AI HAT+ · Hailo-8L", does: "Detects people and objects on the device" },
  { k: "Understanding", what: "SensorDyme software", does: "Tracks, adds context, verifies over time" },
  { k: "Action", what: "Buzzer · event log", does: "Acts in the room once a rule is confirmed" },
];

const privacy = [
  ["On-device", "Detection runs locally on the unit. No continuous cloud upload, and no external AI service in the detection path."],
  ["Local storage", "Events and logs live on the device's own storage. Encryption at rest and encrypted remote channels are planned, not yet implemented."],
  ["Events, not streams", "Alerts are designed to carry structured events rather than video — so you choose what, if anything, leaves the building."],
];

export default function EdgePage() {
  return (
    <>
      {/* Product hero */}
      <section aria-labelledby="edge-hero" className="relative isolate overflow-hidden bg-ink-950 pt-[calc(var(--header-h)+3rem)]">
        <div aria-hidden="true" className="tech-grid absolute inset-0 -z-10 text-bone-50 opacity-50 [mask-image:radial-gradient(ellipse_at_65%_45%,black,transparent_70%)]" />
        <div className="shell grid gap-10 pb-16 lg:min-h-[calc(100svh-var(--header-h)-3rem)] lg:grid-cols-12 lg:items-center lg:pb-10">
          <div className="lg:col-span-5">
            <Eyebrow className="animate-[fade_1.2s_var(--ease-out-expo)_0.2s_both]">SensorDyme Edge</Eyebrow>
            <h1 id="edge-hero" className="t-display mt-6 animate-[fade_1.4s_var(--ease-out-expo)_0.3s_both] uppercase">
              Edge.
            </h1>
            <p className="t-h3 mt-6 max-w-md animate-[fade_1.4s_var(--ease-out-expo)_0.45s_both] text-bone-50/85">Intelligence that stays on site.</p>
            <p className="t-body mt-5 max-w-md animate-[fade_1.4s_var(--ease-out-expo)_0.55s_both] text-bone-50/60">
              A compact edge-AI unit that perceives a scene, follows the people in it, and confirms an event before it raises an alert — on the device itself, with no cloud round-trip.
            </p>
            <div className="mt-8 flex animate-[fade_1.4s_var(--ease-out-expo)_0.65s_both] flex-wrap items-center gap-4">
              <StatusTag tone="signal">Working prototype</StatusTag>
              <StatusTag>Blueprint</StatusTag>
            </div>
          </div>
          <div className="lg:col-span-7">
            <EdgeBlueprint className="mx-auto max-w-[760px]" />
          </div>
        </div>
      </section>

      <section aria-labelledby="explore-title" className="bg-ink-950 pb-28 pt-10 md:pb-36">
        <div className="shell">
          <div className="border-t border-bone-50/10 pt-14">
            <SectionHeading
              id="explore-title"
              index="01"
              eyebrow="Explore the device"
              title="An engineered sensing device."
              body="Rotate the blueprint model and open each component — from the camera on the front face to the neural accelerator inside."
            />
          </div>
          <div className="mt-14 md:mt-20">
            <EdgeExplorer />
          </div>
        </div>
      </section>

      <section aria-labelledby="pipeline-title" className="scroll-mt-20 border-t border-bone-50/[0.06] bg-ink-900 py-28 md:py-36">
        <div className="shell">
          <SectionHeading
            id="pipeline-title"
            index="02"
            eyebrow="How it thinks"
            title="See. Understand. Verify. Act."
            body="The hardware is the sensor; SensorDyme is the product. Follow one moment through the system — select any stage, or let the scene play — to see what the device knows at each step."
          />
          <ol aria-label="From hardware to intelligence" className="mt-14 grid gap-px overflow-hidden rounded-[3px] border border-bone-50/10 bg-bone-50/10 sm:grid-cols-2 lg:grid-cols-4">
            {bridge.map((b, i) => (
              <li key={b.k} className="relative bg-ink-950 p-4 md:p-5">
                <span className="t-mono text-bone-50/55">{b.k}</span>
                <p className="mt-2 text-[0.9375rem] font-medium leading-snug">{b.what}</p>
                <p className="t-small mt-1 text-bone-50/50">{b.does}</p>
                {i < bridge.length - 1 ? (
                  <span aria-hidden="true" className="absolute -right-[7px] top-1/2 z-10 hidden size-3 -translate-y-1/2 rotate-45 border-r border-t border-signal bg-ink-950 lg:block" />
                ) : null}
              </li>
            ))}
          </ol>
          <div className="mt-14 md:mt-20">
            <PerceptionStory />
          </div>
        </div>
      </section>

      <section aria-labelledby="device-title" className="bg-ink-950 py-28 md:py-36">
        <div className="shell">
          <SectionHeading
            id="device-title"
            index="03"
            eyebrow="Current prototype"
            title="The prototype, as built."
            body="Renders of the current prototype industrial design — a flatter enclosure than the blueprint model above, with the same components inside. Open the exploded view to inspect each part."
          />
          <div className="mt-14 md:mt-20">
            <DeviceExplorer />
          </div>
        </div>
      </section>

      <section aria-labelledby="measured-title" className="surface-light py-28 md:py-36">
        <div className="shell">
          <SectionHeading
            id="measured-title"
            index="04"
            eyebrow="What is real today"
            tone="light"
            title="Measured on the prototype."
            body="These figures were measured on a single prototype unit. They describe the prototype, not a finished product. Accuracy figures are withheld until they are measured in the settings SensorDyme is designed for."
          />
          <dl className="mt-14 grid gap-px overflow-hidden rounded-[3px] border border-ink-900/10 bg-ink-900/10 sm:grid-cols-2 lg:grid-cols-4">
            {edgeMeasurements.map((m) => (
              <div key={m.label} className="bg-bone-100 p-6 md:p-8">
                <dt className="t-mono text-ink-900/60">{m.label}</dt>
                <dd className="mt-6">
                  <span className="block text-[clamp(2.25rem,4vw,3.5rem)] font-medium leading-none tracking-[-0.04em]">{m.value}</span>
                  <span className="t-small mt-3 block text-ink-900/60">{m.note}</span>
                </dd>
              </div>
            ))}
          </dl>
          <ul className="mt-14 border-t border-ink-900/15">
            {edgeStatus.map((s) => (
              <li key={s.name} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b border-ink-900/10 py-4">
                <span className="text-[0.9375rem] text-ink-900/80">{s.name}</span>
                <StatusTag tone="light" className={cn(s.status === "Verified on prototype" && "border-ink-900/40 text-ink-900")}>
                  {s.status}
                </StatusTag>
              </li>
            ))}
          </ul>
          <MediaNote className="mt-6">Prototype: Raspberry Pi 5 with AI HAT+ (Hailo-8L) and Camera Module 3 Wide NoIR. Measurements recorded August 2026.</MediaNote>
        </div>
      </section>

      <section aria-labelledby="jupiter-title" className="bg-ink-950 py-28 md:py-36">
        <div className="shell">
          <SectionHeading
            id="jupiter-title"
            index="05"
            eyebrow="Jupiter"
            title="Tell it what matters. In your own words."
            body={jupiter.summary}
            aside={<StatusTag>{jupiter.status}</StatusTag>}
          />
          <Reveal className="mt-14 grid gap-px overflow-hidden rounded-[3px] border border-bone-50/10 bg-bone-50/10 md:grid-cols-2">
            <div className="bg-ink-900 p-6 md:p-10">
              <p className="t-eyebrow text-bone-50/50">You say</p>
              <p className="t-h3 mt-6 max-w-md text-bone-50/90">{jupiter.example.say}</p>
            </div>
            <div className="bg-ink-950 p-6 md:p-10">
              <p className="t-eyebrow text-bone-50/50">Jupiter compiles · the safety engine enforces</p>
              <dl className="t-mono mt-6 border-t border-bone-50/10">
                {jupiter.example.rule.map(([k, v]) => (
                  <div key={k} className="grid grid-cols-[4rem_1fr] gap-4 border-b border-bone-50/10 py-3 text-[0.8125rem]">
                    <dt className="text-signal">{k.toUpperCase()}</dt>
                    <dd className="text-bone-50/85">{v}</dd>
                  </div>
                ))}
              </dl>
              <p className="t-small mt-6 text-bone-50/55">Rules are picked from what the device can actually detect, then validated. A wrong guess becomes a rejected rule — never a camera watching the wrong thing.</p>
            </div>
          </Reveal>

          <div className="mt-20 grid gap-10 md:grid-cols-12">
            <div className="md:col-span-4">
              <p className="t-eyebrow text-bone-50/50">Privacy by architecture</p>
              <h3 className="t-h3 mt-4">Your footage never has to leave the building.</h3>
            </div>
            <ul className="grid gap-8 sm:grid-cols-3 md:col-span-8">
              {privacy.map(([k, v]) => (
                <li key={k} className="border-t border-bone-50/15 pt-4">
                  <p className="text-[1.0625rem] font-medium">{k}</p>
                  <p className="t-small mt-2 text-bone-50/60">{v}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section aria-labelledby="modes-title" className="border-t border-bone-50/[0.06] bg-ink-900 py-28 md:py-36">
        <div className="shell">
          <SectionHeading
            id="modes-title"
            index="06"
            eyebrow="Designed for"
            title="Moments nobody is watching."
            body="Monitoring modes that exist in the prototype software today. Each is being validated; none is offered as a commercial service yet."
          />
          <ol className="mt-14 grid gap-px overflow-hidden rounded-[3px] border border-bone-50/10 bg-bone-50/10 sm:grid-cols-2 lg:grid-cols-4">
            {edgeModes.map((m, i) => (
              <li key={m.name} className="bg-ink-950 p-6 md:p-8">
                <p className="t-mono text-bone-50/55">{String(i + 1).padStart(2, "0")}</p>
                <h3 className="t-h4 mt-10">{m.name}</h3>
                <p className="t-small mt-3 text-bone-50/60">{m.body}</p>
              </li>
            ))}
          </ol>

          <div className="mt-20 flex flex-col items-start justify-between gap-8 border-t border-bone-50/10 pt-10 md:flex-row md:items-center">
            <div>
              <p className="t-h4 max-w-xl text-bone-50/85">The same intelligence, given altitude.</p>
              <TextLink href="/aero" className="mt-4">
                Explore SensorDyme Aero
              </TextLink>
            </div>
            <ButtonLink href="/contact?intent=demo">Talk to the team</ButtonLink>
          </div>
        </div>
      </section>
    </>
  );
}
