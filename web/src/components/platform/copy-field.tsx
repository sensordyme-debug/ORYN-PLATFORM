"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";

/** Read-only value with a copy button — used for one-time secrets (invitation links, API keys). */
export function CopyField({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cn("flex items-stretch overflow-hidden rounded-[3px] border border-bone-50/15", className)}>
      <input readOnly value={value} aria-label="Value to copy" className="t-mono min-w-0 flex-1 bg-ink-950 px-2 py-1.5 text-[0.75rem] text-bone-50" onFocus={(e) => e.currentTarget.select()} />
      <button
        type="button"
        className="border-l border-bone-50/15 px-3 text-[0.75rem] text-bone-50/75 hover:bg-bone-50/[0.06]"
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
