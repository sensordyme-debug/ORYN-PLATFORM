import type { Metadata } from "next";
import { credits, dataCredits, type Credit } from "@/content/credits";

export const metadata: Metadata = {
  title: "Media credits",
  description: "Sources and licenses for photography, video, data, and typefaces used on the ORYN website.",
  alternates: { canonical: "/credits" },
};

function Row({ c }: { c: Credit }) {
  return (
    <li className="grid gap-2 border-b border-bone-50/10 py-5 md:grid-cols-12 md:gap-6">
      <div className="md:col-span-4">
        <p className="t-mono text-bone-50/80">{c.file}</p>
        <p className="t-small mt-1 text-bone-50/50">{c.description}</p>
      </div>
      <p className="text-[0.9375rem] md:col-span-3">
        {c.authorUrl ? (
          <a href={c.authorUrl} className="underline-offset-4 hover:underline" rel="noopener noreferrer" target="_blank">
            {c.author}
          </a>
        ) : (
          c.author
        )}
      </p>
      <p className="t-small md:col-span-3">
        {c.licenseUrl ? (
          <a href={c.licenseUrl} className="text-bone-50/70 underline-offset-4 hover:underline" rel="noopener noreferrer" target="_blank">
            {c.license}
          </a>
        ) : (
          <span className="text-bone-50/70">{c.license}</span>
        )}
      </p>
      <p className="t-small md:col-span-2 md:text-right">
        <a href={c.source} className="text-bone-50/55 underline-offset-4 hover:text-bone-50 hover:underline" rel="noopener noreferrer" target="_blank">
          Source ↗
        </a>
      </p>
    </li>
  );
}

export default function CreditsPage() {
  return (
    <section className="bg-ink-950 pb-28 pt-[calc(var(--header-h)+5rem)]">
      <div className="shell">
        <p className="t-eyebrow text-bone-50/50">Media credits</p>
        <h1 className="t-h1 mt-6 max-w-4xl">Sources & licenses.</h1>
        <p className="t-lead mt-6 max-w-2xl text-bone-50/65">
          Photography and footage on this site are licensed stock media representing the environments and technology categories ORYN works with. Third-party aircraft shown are not ORYN products.
        </p>

        <h2 className="t-eyebrow mt-20 text-bone-50/50">Data & typefaces</h2>
        <ul className="mt-4 border-t border-bone-50/10">
          {dataCredits.map((c) => (
            <Row key={c.file} c={c} />
          ))}
        </ul>

        <h2 className="t-eyebrow mt-20 text-bone-50/50">Photography & video</h2>
        <ul className="mt-4 border-t border-bone-50/10">
          {credits.map((c) => (
            <Row key={c.file} c={c} />
          ))}
        </ul>
      </div>
    </section>
  );
}
