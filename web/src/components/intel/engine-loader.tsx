"use client";

import dynamic from "next/dynamic";
import type { EngineWorkspaceProps } from "@/components/intel/engine-workspace";

/** The globe needs the browser (WebGL, workers); load it on the client only, in its own chunk. */
const EngineWorkspace = dynamic(() => import("@/components/intel/engine-workspace").then((m) => m.EngineWorkspace), {
  ssr: false,
  loading: () => <p className="p-6 text-[0.8125rem] text-bone-50/55" role="status">Loading the 3D globe…</p>,
});

export function EngineWorkspaceLoader(props: EngineWorkspaceProps) {
  return <EngineWorkspace {...props} />;
}
