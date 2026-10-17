import Link from "next/link";
import { HeroMedia } from "@/components/media/hero-media";
import { ButtonLink } from "@/components/ui/button";
import { media, video } from "@/content/media";

const products = [
  { n: "01", name: "SensorDyme Edge", desc: "Intelligent edge sensing", href: "/edge" },
  { n: "02", name: "SensorDyme Aero", desc: "Aerial development platform", href: "/aero" },
  { n: "03", name: "ORYN Command & Portal", desc: "Operations and delivery", href: "/platform" },
];

export function Hero() {
  return (
    <section aria-labelledby="hero-title" className="relative isolate h-[100svh] min-h-[620px] overflow-hidden bg-ink-950">
      <HeroMedia
        poster={media.heroPoster.src}
        posterMobile={media.heroMobilePoster.src}
        alt={media.heroPoster.alt}
        video={video.hero}
        className="-z-10"
      />
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-56 bg-gradient-to-b from-ink-950/75 via-ink-950/25 to-transparent" />
      <div aria-hidden="true" className="absolute inset-0 bg-[linear-gradient(to_top,rgb(6_7_7/0.95)_0%,rgb(6_7_7/0.7)_30%,rgb(6_7_7/0.4)_55%,rgb(6_7_7/0.12)_75%,transparent_90%)]" />
      <div aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(ellipse_at_10%_100%,rgb(6_7_7/0.55),transparent_55%)]" />

      <div className="shell relative flex h-full flex-col justify-end pb-[max(2rem,env(safe-area-inset-bottom))] md:pb-10">
        <p className="t-eyebrow animate-[fade_1.2s_var(--ease-out-expo)_0.5s_both] text-bone-50/85">ORYN — Intelligent Physical Systems</p>
        <h1 id="hero-title" className="mt-5 text-[clamp(2.6rem,13vw,11.75rem)] font-medium uppercase leading-[0.86] tracking-[-0.055em]">
          <span className="line-mask">
            <span className="block animate-[rise_1.3s_var(--ease-out-expo)_0.15s_both]">Intelligence</span>
          </span>
          <span className="line-mask">
            <span className="block animate-[rise_1.3s_var(--ease-out-expo)_0.28s_both]">in the field.</span>
          </span>
        </h1>

        <div className="mt-8 grid gap-7 md:mt-10 md:grid-cols-12 md:items-end">
          <p className="t-lead max-w-md animate-[fade_1.4s_var(--ease-out-expo)_0.7s_both] text-bone-50/80 md:col-span-5">
            ORYN builds systems that perceive and understand the physical world. SensorDyme is the intelligence — on site today with Edge, and in development for the air with Aero.
          </p>
          <div className="flex animate-[fade_1.4s_var(--ease-out-expo)_0.85s_both] flex-col gap-3 sm:flex-row md:col-span-7 md:justify-end">
            <ButtonLink href="#sensordyme">Explore SensorDyme</ButtonLink>
            <ButtonLink href="/technology" variant="secondary">
              Our Technology
            </ButtonLink>
          </div>
        </div>

        <nav aria-label="Products" className="mt-10 hidden animate-[fade_1.6s_var(--ease-out-expo)_1.1s_both] grid-cols-3 border-t border-bone-50/15 md:grid">
          {products.map((p) => (
            <Link key={p.href} href={p.href} className="group flex items-baseline gap-4 border-r border-bone-50/10 py-4 pr-6 last:border-r-0 [&:not(:first-child)]:pl-6">
              <span className="t-mono text-bone-50/55">{p.n}</span>
              <span className="whitespace-nowrap text-[0.9375rem] font-medium">{p.name}</span>
              <span className="t-small hidden truncate text-bone-50/50 xl:inline">{p.desc}</span>
              <span aria-hidden="true" className="ml-auto text-bone-50/55 transition-transform duration-300 group-hover:translate-x-1 group-hover:text-bone-50">
                →
              </span>
            </Link>
          ))}
        </nav>
      </div>
    </section>
  );
}
