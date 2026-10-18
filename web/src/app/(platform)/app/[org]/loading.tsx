/** Shown inside the workspace shell while a page's data loads. */
export default function OrgPageLoading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="h-3 w-24 rounded-[2px] bg-bone-50/[0.06] motion-safe:animate-pulse" />
        <div className="h-7 w-72 max-w-full rounded-[2px] bg-bone-50/[0.08] motion-safe:animate-pulse" />
      </div>
      <div className="h-40 rounded-[4px] border border-bone-50/[0.09] bg-ink-850 motion-safe:animate-pulse" />
      <p className="text-[0.8125rem] text-bone-50/60">Loading…</p>
    </div>
  );
}
