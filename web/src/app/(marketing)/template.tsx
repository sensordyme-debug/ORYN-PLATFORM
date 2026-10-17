"use client";

import { useEffect, type ReactNode } from "react";

// The first page load renders without a transition, so the server-rendered
// hero paints immediately (good for LCP). Client-side navigations after
// that fade in. The template re-mounts on every navigation.
let hasNavigated = false;

export default function Template({ children }: { children: ReactNode }) {
  const animate = hasNavigated;
  useEffect(() => {
    hasNavigated = true;
  }, []);
  return <div className={animate ? "animate-[fade_0.7s_var(--ease-out-expo)_both]" : undefined}>{children}</div>;
}
