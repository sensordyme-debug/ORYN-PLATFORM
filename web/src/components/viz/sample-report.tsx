import Image from "next/image";
import { LogoMark } from "@/components/brand/logo";
import fieldImg from "@/assets/usgs/portal-field.jpg";

const findings = [
  { id: "01", area: "East circle", issue: "Patchy growth, south-west half", priority: "High", action: "Inspect outer sprinkler spans" },
  { id: "02", area: "Center circle", issue: "Faint ring pattern", priority: "Watch", action: "Re-check next inspection" },
  { id: "03", area: "Drainage area", issue: "Saturated ground", priority: "Watch", action: "Avoid heavy equipment" },
];

/** A sample intelligence report, rendered as a document. Illustrative content. */
export function SampleReport() {
  return (
    <div className="relative mx-auto max-w-4xl">
      <div aria-hidden="true" className="absolute inset-x-6 -bottom-3 top-3 rounded-[4px] bg-bone-200/60" />
      <article className="relative rounded-[4px] bg-paper p-6 text-ink-900 shadow-[0_40px_80px_-40px_rgba(0,0,0,0.6)] md:p-12">
        <header className="flex items-start justify-between gap-6 border-b border-ink-900/15 pb-6">
          <div>
            <p className="t-mono text-ink-900/60">Field intelligence report · Sample</p>
            <h3 className="mt-2 text-[1.5rem] font-medium tracking-[-0.025em] md:text-[2rem]">North Block — Inspection 12</h3>
            <p className="t-small mt-1 text-ink-900/65">Prepared by ORYN · Illustrative document · Not a real property</p>
          </div>
          <LogoMark className="h-8 w-auto shrink-0 text-ink-900" aria-hidden="true" />
        </header>

        <div className="mt-8 grid gap-8 md:grid-cols-5">
          <div className="md:col-span-3">
            <p className="t-eyebrow text-ink-900/60">Summary</p>
            <p className="mt-3 text-[1.0625rem] leading-relaxed">
              Overall condition is stable. One area — the south-west half of the east circle — shows weaker, uneven growth consistent with an irrigation problem and should be checked this week.
            </p>
            <dl className="mt-6 grid grid-cols-3 gap-4 border-t border-ink-900/10 pt-5">
              <div>
                <dt className="t-mono text-ink-900/60">Area surveyed</dt>
                <dd className="mt-1 text-[1rem] font-medium">≈ 160 ac</dd>
              </div>
              <div>
                <dt className="t-mono text-ink-900/60">Findings</dt>
                <dd className="mt-1 text-[1rem] font-medium">3</dd>
              </div>
              <div>
                <dt className="t-mono text-ink-900/60">Reviewed by</dt>
                <dd className="mt-1 text-[1rem] font-medium">Analyst</dd>
              </div>
            </dl>
          </div>
          <figure className="md:col-span-2">
            <div className="relative aspect-square overflow-hidden rounded-[2px]">
              <Image src={fieldImg} alt="Aerial map of the sample property" fill sizes="(min-width: 768px) 30vw, 100vw" placeholder="blur" className="object-cover" />
              <svg viewBox="0 0 1600 1600" className="absolute inset-0 size-full" aria-hidden="true">
                <path d="M805 780C905 790 1030 860 1110 960C1160 1040 1165 1150 1120 1240C1100 1280 1085 1300 1075 1312L805 1312Z" fill="#d4531c" fillOpacity="0.3" stroke="#d4531c" strokeWidth="6" />
                <circle cx="540" cy="752" r="236" fill="none" stroke="#b8860b" strokeWidth="5" strokeDasharray="16 12" />
                <ellipse cx="1010" cy="1392" rx="120" ry="46" fill="none" stroke="#b8860b" strokeWidth="5" strokeDasharray="16 12" />
              </svg>
            </div>
            <figcaption className="t-mono mt-2 text-ink-900/60">Fig. 1 — Areas of interest</figcaption>
          </figure>
        </div>

        <div className="mt-10 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-[0.875rem]">
            <thead>
              <tr className="t-mono border-b border-ink-900/15 text-ink-900/60">
                <th className="py-2 pr-4 font-normal">#</th>
                <th className="py-2 pr-4 font-normal">Area</th>
                <th className="py-2 pr-4 font-normal">Observation</th>
                <th className="py-2 pr-4 font-normal">Priority</th>
                <th className="py-2 font-normal">Recommended action</th>
              </tr>
            </thead>
            <tbody>
              {findings.map((f) => (
                <tr key={f.id} className="border-b border-ink-900/[0.08]">
                  <td className="t-mono py-3 pr-4 text-ink-900/60">{f.id}</td>
                  <td className="py-3 pr-4 font-medium">{f.area}</td>
                  <td className="py-3 pr-4 text-ink-900/70">{f.issue}</td>
                  <td className="py-3 pr-4">
                    <span className={f.priority === "High" ? "text-[#b5420f]" : "text-[#8a6408]"}>{f.priority}</span>
                  </td>
                  <td className="py-3 text-ink-900/70">{f.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <footer className="t-mono mt-8 flex flex-wrap justify-between gap-2 text-ink-900/60">
          <span>Imagery: USGS orthoimagery (public domain)</span>
          <span>Page 1 of 4 · Sample</span>
        </footer>
      </article>
    </div>
  );
}
