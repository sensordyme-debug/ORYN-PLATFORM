"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Logo } from "@/components/brand/logo";
import { primaryNav, site, type NavItem } from "@/content/site";
import { industries } from "@/content/industries";
import { cn } from "@/lib/cn";

type MenuEntry = { n: string; title: string; desc: string; href: string };

/** Dropdown contents for nav items that have them: product families and solutions. */
function dropdownFor(item: NavItem): MenuEntry[] | null {
  if (item.children) {
    return item.children.map((c, i) => ({ n: String(i + 1).padStart(2, "0"), title: c.label, desc: c.description ?? "", href: c.href }));
  }
  if (item.href === "/solutions") {
    return industries.map((ind) => ({ n: ind.index, title: ind.name, desc: ind.headline, href: `/solutions/${ind.slug}` }));
  }
  return null;
}

export function Header() {
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [open, setOpen] = useState(false);
  const lastY = useRef(0);

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      setScrolled(y > 24);
      // Hide on scroll down, reveal on scroll up — never while near the top.
      if (y > 480 && y > lastY.current + 6) setHidden(true);
      else if (y < lastY.current - 6 || y < 480) setHidden(false);
      lastY.current = y;
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close the menu when the route changes (adjust state during render).
  const [prevPath, setPrevPath] = useState(pathname);
  if (pathname !== prevPath) {
    setPrevPath(pathname);
    setOpen(false);
  }

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");

  return (
    <>
      <header
        className={cn(
          "fixed inset-x-0 top-0 z-50 transition-[transform,background-color,border-color] duration-500 ease-out",
          hidden && !open ? "-translate-y-full" : "translate-y-0",
          scrolled && !open
            ? "border-b border-bone-50/[0.07] bg-ink-950/75 backdrop-blur-xl backdrop-saturate-150"
            : "border-b border-transparent bg-transparent",
        )}
      >
        <div className="shell flex h-[var(--header-h)] items-center justify-between gap-6">
          <Link href="/" className="relative z-10 -m-2 p-2 text-bone-50" aria-label="ORYN — home">
            <Logo className="h-[22px] w-auto md:h-6" title="ORYN" />
          </Link>

          <nav aria-label="Primary" className="hidden items-center lg:flex">
            <ul className="flex items-center gap-1">
              {primaryNav.map((item) => {
                const menu = dropdownFor(item);
                const active = isActive(item.href) || !!item.children?.some((c) => isActive(c.href));
                return (
                  <li key={item.href} className={menu ? "group relative" : undefined}>
                    <Link
                      href={item.href}
                      aria-current={isActive(item.href) ? "page" : undefined}
                      className={cn(
                        "relative block px-3.5 py-2 text-[0.875rem] tracking-[-0.005em] transition-colors",
                        active ? "text-bone-50" : "text-bone-50/65 hover:text-bone-50",
                      )}
                    >
                      {item.label}
                      {active ? <span aria-hidden="true" className="absolute inset-x-3.5 -bottom-px h-px bg-bone-50/70" /> : null}
                    </Link>
                    {menu ? (
                      <div className="pointer-events-none invisible absolute left-1/2 top-full w-[440px] -translate-x-1/2 pt-3 opacity-0 transition-[opacity,visibility] duration-300 group-focus-within:pointer-events-auto group-focus-within:visible group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:visible group-hover:opacity-100">
                        <div className="border border-bone-50/10 bg-ink-900/95 p-2 shadow-2xl shadow-black/50 backdrop-blur-xl">
                          <ul>
                            {menu.map((m) => (
                              <li key={m.href}>
                                <Link
                                  href={m.href}
                                  aria-current={isActive(m.href) ? "page" : undefined}
                                  className="flex items-baseline gap-4 rounded-[2px] px-3 py-2.5 transition-colors hover:bg-bone-50/[0.05]"
                                >
                                  <span className="t-mono text-bone-50/55">{m.n}</span>
                                  <span>
                                    <span className="block text-[0.9375rem] text-bone-50">{m.title}</span>
                                    <span className="block text-[0.8125rem] text-bone-50/50">{m.desc}</span>
                                  </span>
                                </Link>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="relative z-10 flex items-center gap-2">
            {site.commandUrl ? (
              <a
                href={site.commandUrl}
                className="hidden px-3 py-2 text-[0.875rem] text-bone-50/65 transition-colors hover:text-bone-50 lg:block"
              >
                Sign in
              </a>
            ) : null}
            <Link
              href="/contact?intent=demo"
              className="hidden h-10 items-center rounded-[2px] bg-bone-50 px-4 text-[0.875rem] font-medium text-ink-900 transition-colors hover:bg-white sm:inline-flex"
            >
              Talk to the team
            </Link>
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-controls="mobile-menu"
              className="-mr-2 flex h-11 items-center gap-3 px-2 text-[0.875rem] text-bone-50 lg:hidden"
            >
              <span>{open ? "Close" : "Menu"}</span>
              <span aria-hidden="true" className="relative block h-3 w-5">
                <span
                  className={cn(
                    "absolute left-0 h-px w-5 bg-current transition-transform duration-500 ease-out",
                    open ? "top-1.5 rotate-45" : "top-0.5",
                  )}
                />
                <span
                  className={cn(
                    "absolute left-0 h-px w-5 bg-current transition-transform duration-500 ease-out",
                    open ? "top-1.5 -rotate-45" : "top-2.5",
                  )}
                />
              </span>
            </button>
          </div>
        </div>
      </header>
      <MobileMenu open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function MobileMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])");
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    const t = window.setTimeout(() => panelRef.current?.querySelector<HTMLElement>("a[href]")?.focus(), 60);
    const mq = window.matchMedia("(min-width: 1024px)");
    const onMq = () => mq.matches && onClose();
    mq.addEventListener("change", onMq);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKeyDown);
      mq.removeEventListener("change", onMq);
      window.clearTimeout(t);
    };
  }, [open, onKeyDown, onClose]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          id="mobile-menu"
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label="Site menu"
          className="fixed inset-0 z-40 flex flex-col overflow-y-auto bg-ink-950 pt-[var(--header-h)] lg:hidden"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        >
          <nav aria-label="Mobile" className="shell flex flex-1 flex-col pb-10 pt-6">
            <ul className="border-t border-bone-50/10">
              {[{ label: "Home", href: "/" }, ...primaryNav.flatMap((n) => n.children ?? [n]), { label: "Contact", href: "/contact" }].map((item, i) => (
                <motion.li
                  key={item.href}
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.6, delay: 0.04 * i, ease: [0.16, 1, 0.3, 1] }}
                  className="border-b border-bone-50/10"
                >
                  <Link href={item.href} className="flex items-baseline justify-between py-4" onClick={onClose}>
                    <span className="text-[1.75rem] font-medium tracking-[-0.035em]">{item.label}</span>
                    <span className="t-mono text-bone-50/55">{String(i).padStart(2, "0")}</span>
                  </Link>
                </motion.li>
              ))}
            </ul>
            <div className="mt-8 grid grid-cols-2 gap-x-6 gap-y-2.5">
              {industries.map((ind) => (
                <Link
                  key={ind.slug}
                  href={`/solutions/${ind.slug}`}
                  onClick={onClose}
                  className="text-[0.9375rem] text-bone-50/60 hover:text-bone-50"
                >
                  {ind.name}
                </Link>
              ))}
            </div>
            <div className="mt-auto pt-10">
              <Link
                href="/contact?intent=demo"
                onClick={onClose}
                className="flex h-14 items-center justify-center rounded-[2px] bg-bone-50 text-[1rem] font-medium text-ink-900"
              >
                Talk to the team
              </Link>
              <p className="t-mono mt-6 text-bone-50/55">{site.tagline}</p>
            </div>
          </nav>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
