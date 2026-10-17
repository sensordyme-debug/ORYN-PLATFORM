import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHero } from "@/components/layout/page-hero";
import { ContactForm } from "@/components/contact/contact-form";
import { media } from "@/content/media";
import { site } from "@/content/site";

export const metadata: Metadata = {
  title: "Contact",
  description: "Get in touch with ORYN or request a demo of our aerial intelligence platform in development.",
  alternates: { canonical: "/contact" },
};

const next = [
  ["01", "We read every message", "Your inquiry goes directly to the founding team."],
  ["02", "We follow up", "We'll reply to schedule a conversation or answer your questions."],
  ["03", "We explore fit", "For demos, we'll walk through the platform previews and discuss your use case."],
];

export default function ContactPage() {
  return (
    <>
      <PageHero
        eyebrow="Contact"
        title={<span className="uppercase">Let&apos;s see what&apos;s possible.</span>}
        lead="Tell us about your land, your site, or your project — or ask us anything about what we're building."
        image={media.contact}
        credit={media.contact.credit}
        tall={false}
      />
      <section aria-label="Contact form" className="surface-light py-20 md:py-28">
        <div className="shell grid gap-16 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <p className="t-eyebrow text-ink-900/60">What happens next</p>
            <ol className="mt-6 border-t border-ink-900/15">
              {next.map(([n, t, b]) => (
                <li key={n} className="border-b border-ink-900/10 py-5">
                  <p className="t-mono text-ink-900/60">{n}</p>
                  <p className="mt-2 text-[1.0625rem] font-medium">{t}</p>
                  <p className="t-small mt-1 text-ink-900/60">{b}</p>
                </li>
              ))}
            </ol>
            {site.contactEmail ? (
              <p className="t-small mt-8 text-ink-900/60">
                Prefer email?{" "}
                <a href={`mailto:${site.contactEmail}`} className="font-medium text-ink-900 underline underline-offset-4">
                  {site.contactEmail}
                </a>
              </p>
            ) : null}
          </div>
          <div className="lg:col-span-7 lg:col-start-6">
            <Suspense fallback={<div className="h-[640px]" aria-hidden="true" />}>
              <ContactForm fallbackEmail={site.contactEmail} />
            </Suspense>
          </div>
        </div>
      </section>
    </>
  );
}
