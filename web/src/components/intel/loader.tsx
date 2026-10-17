"use client";

import dynamic from "next/dynamic";
import type { IntelWorkspaceProps } from "@/components/intel/intel-workspace";

/** The globe needs the browser (WebGL, workers); load it on the client only, in its own chunk. */
const IntelWorkspace = dynamic(() => import("@/components/intel/intel-workspace").then((m) => m.IntelWorkspace), {
  ssr: false,
  loading: () => <p className="p-6 text-[0.8125rem] text-bone-50/55" role="status">Loading the 3D globe…</p>,
});

export function IntelWorkspaceLoader(props: IntelWorkspaceProps) {
  return <IntelWorkspace {...props} />;
}
