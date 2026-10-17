"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

export function SettingsTabs({ tabs }: { tabs: { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings sections" className="-mt-3 flex gap-1 border-b border-bone-50/[0.08]">
      {tabs.map((t) => {
        const active = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={cn("-mb-px border-b px-3 py-2 text-[0.8125rem]", active ? "border-signal text-bone-50" : "border-transparent text-bone-50/55 hover:text-bone-50")}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
