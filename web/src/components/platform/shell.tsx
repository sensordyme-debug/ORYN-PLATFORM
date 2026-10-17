"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import {
  Bell,
  ChevronDown,
  ClipboardCheck,
  Cpu,
  Database,
  FileText,
  Globe2,
  LayoutDashboard,
  LogOut,
  Map as MapIcon,
  Menu,
  ScrollText,
  Settings,
  Shapes,
  Siren,
  X,
} from "lucide-react";
import { LogoMark } from "@/components/brand/logo";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/cn";

export type NavItem = { href: string; label: string; icon: keyof typeof ICONS; badge?: number };
export type OrgOption = { slug: string; name: string; role: string };

const ICONS = {
  overview: LayoutDashboard,
  map: MapIcon,
  globe: Globe2,
  areas: Shapes,
  review: ClipboardCheck,
  alerts: Siren,
  reports: FileText,
  processing: Cpu,
  sources: Database,
  settings: Settings,
  audit: ScrollText,
} as const;

export function PlatformShell({
  orgSlug,
  orgName,
  orgs,
  nav,
  user,
  unread,
  roleLabel,
  banner,
  children,
}: {
  orgSlug: string;
  orgName: string;
  orgs: OrgOption[];
  nav: NavItem[];
  user: { name: string; handle: string; isPlatformAdmin: boolean };
  unread: number;
  roleLabel: string;
  banner?: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [prevPath, setPrevPath] = useState(pathname);
  if (prevPath !== pathname) {
    setPrevPath(pathname);
    setOpen(false);
  }
  const base = `/app/${orgSlug}`;
  const isActive = (href: string) => (href === base ? pathname === base : pathname === href || pathname.startsWith(href + "/"));
  const fullBleed = pathname === `${base}/map` || pathname === `${base}/intel`;

  return (
    <div className="flex h-[100svh] overflow-hidden bg-ink-900 text-bone-50">
      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-bone-50/[0.08] bg-ink-950 transition-transform duration-300 lg:static lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
        aria-label="Platform navigation"
      >
        <div className="flex h-14 items-center gap-2.5 border-b border-bone-50/[0.08] px-4">
          <Link href="/app" className="flex items-center gap-2.5" aria-label="ORYN platform home">
            <LogoMark className="h-5 w-auto text-bone-50" aria-hidden="true" />
            <span className="t-mono text-[0.6875rem] uppercase tracking-[0.16em] text-bone-50/60">Platform</span>
          </Link>
          <button className="ml-auto p-1 text-bone-50/60 lg:hidden" onClick={() => setOpen(false)} aria-label="Close navigation">
            <X className="size-4" />
          </button>
        </div>
        <OrgSwitcher current={orgSlug} name={orgName} orgs={orgs} roleLabel={roleLabel} />
        <nav className="flex-1 overflow-y-auto px-2 py-3">
          <ul className="flex flex-col gap-0.5">
            {nav.map((item) => {
              const Icon = ICONS[item.icon];
              const active = isActive(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2.5 rounded-[3px] px-2.5 py-1.5 text-[0.8125rem] transition-colors",
                      active ? "bg-bone-50/[0.08] text-bone-50" : "text-bone-50/60 hover:bg-bone-50/[0.04] hover:text-bone-50",
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    <span className="flex-1">{item.label}</span>
                    {item.badge ? (
                      <span className="t-mono rounded-full bg-signal/15 px-1.5 text-[0.625rem] text-signal">{item.badge > 99 ? "99+" : item.badge}</span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="border-t border-bone-50/[0.08] p-3">
          {user.isPlatformAdmin ? (
            <Link href="/app/admin" className="mb-2 block rounded-[3px] px-2 py-1 text-[0.75rem] text-bone-50/55 hover:text-bone-50">
              Platform administration
            </Link>
          ) : null}
          <div className="flex items-center gap-2 px-2">
            <Link href="/app/account" className="min-w-0 flex-1 rounded-[3px] hover:text-bone-50" title="Your account">
              <p className="truncate text-[0.8125rem]">{user.name}</p>
              <p className="truncate text-[0.6875rem] text-bone-50/45">{user.handle}</p>
            </Link>
            <SignOut />
          </div>
        </div>
      </aside>
      {open ? <div className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={() => setOpen(false)} aria-hidden="true" /> : null}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-bone-50/[0.08] bg-ink-950/60 px-3 lg:px-5">
          <button className="rounded-[3px] p-1.5 text-bone-50/70 lg:hidden" onClick={() => setOpen(true)} aria-label="Open navigation" aria-expanded={open}>
            <Menu className="size-5" />
          </button>
          <p className="truncate text-[0.875rem] font-medium">{orgName}</p>
          <div className="ml-auto flex items-center gap-1">
            <Link
              href={`${base}/alerts?view=notifications`}
              className="relative rounded-[3px] p-2 text-bone-50/65 hover:bg-bone-50/[0.05] hover:text-bone-50"
              aria-label={unread ? `${unread} unread notifications` : "Notifications"}
            >
              <Bell className="size-4" />
              {unread ? <span className="absolute right-1 top-1 size-2 rounded-full bg-signal" aria-hidden="true" /> : null}
            </Link>
          </div>
        </header>
        {banner}
        <main id="main" className={cn("min-h-0 flex-1", fullBleed ? "overflow-hidden" : "overflow-y-auto")}>
          {fullBleed ? children : <div className="mx-auto w-full max-w-[1400px] px-4 py-6 lg:px-8">{children}</div>}
        </main>
      </div>
    </div>
  );
}

function OrgSwitcher({ current, name, orgs, roleLabel }: { current: string; name: string; orgs: OrgOption[]; roleLabel: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <div className="relative border-b border-bone-50/[0.08] px-3 py-3">
      <button
        className="flex w-full items-center gap-2 rounded-[3px] px-1.5 py-1 text-left hover:bg-bone-50/[0.04]"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.8125rem] font-medium">{name}</span>
          <span className="block text-[0.6875rem] text-bone-50/45">{roleLabel}</span>
        </span>
        <ChevronDown className="size-4 text-bone-50/50" aria-hidden="true" />
      </button>
      {open ? (
        <ul role="listbox" aria-label="Organizations" className="absolute inset-x-3 top-full z-50 mt-1 rounded-[3px] border border-bone-50/10 bg-ink-850 p-1 shadow-2xl">
          {orgs.map((o) => (
            <li key={o.slug} role="option" aria-selected={o.slug === current}>
              <Link
                href={`/app/${o.slug}`}
                onClick={() => setOpen(false)}
                className={cn("block rounded-[2px] px-2 py-1.5 text-[0.8125rem] hover:bg-bone-50/[0.06]", o.slug === current && "text-signal")}
              >
                {o.name}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SignOut() {
  const router = useRouter();
  return (
    <button
      className="rounded-[3px] p-1.5 text-bone-50/50 hover:bg-bone-50/[0.06] hover:text-bone-50"
      aria-label="Sign out"
      title="Sign out"
      onClick={async () => {
        await authClient.signOut();
        router.replace("/login");
        router.refresh();
      }}
    >
      <LogOut className="size-4" />
    </button>
  );
}
