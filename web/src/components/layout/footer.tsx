import Link from "next/link";
import { Wordmark, LogoMark } from "@/components/brand/logo";
import { footerNav, site } from "@/content/site";

export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="relative overflow-hidden border-t border-bone-50/[0.08] bg-ink-950 text-bone-50">
      <div className="shell pb-8 pt-20 md:pt-28">
        <div className="grid gap-14 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <LogoMark className="h-10 w-auto text-bone-50" />
            <p className="t-lead mt-8 max-w-sm text-bone-50/80">
              Intelligent physical systems. SensorDyme perception — on site with Edge, in development for the air with Aero.
            </p>
            <Link
              href="/contact?intent=demo"
              className="group mt-8 inline-flex items-center gap-3 text-[0.9375rem] font-medium"
            >
              <span className="border-b border-bone-50/30 pb-1 transition-colors group-hover:border-bone-50">
                Talk to the team
              </span>
              <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">
                →
              </span>
            </Link>
          </div>
          <nav aria-label="Footer" className="grid grid-cols-2 gap-10 sm:grid-cols-3 lg:col-span-7 lg:col-start-6">
            {footerNav.map((group) => (
              <div key={group.title}>
                <h2 className="t-eyebrow text-bone-50/55">{group.title}</h2>
                <ul className="mt-5 space-y-3">
                  {group.items.map((item) => (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className="text-[0.9375rem] text-bone-50/70 transition-colors hover:text-bone-50"
                      >
                        {item.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        <div className="mt-24 md:mt-32">
          <Wordmark className="h-auto w-full text-bone-50/[0.92]" aria-hidden="true" />
        </div>

        <div className="mt-10 flex flex-col gap-4 border-t border-bone-50/[0.08] pt-6 text-bone-50/60 md:flex-row md:items-center md:justify-between">
          <p className="t-mono max-w-2xl">{site.stageNote}</p>
          <p className="t-mono shrink-0">© {year} ORYN. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}
