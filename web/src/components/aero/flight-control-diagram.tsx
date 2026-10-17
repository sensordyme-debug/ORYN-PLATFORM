import { companionChain, flightControlChain } from "@/content/aero";

function Chain({ title, note, nodes, accent }: { title: string; note: string; nodes: { id: string; label: string; body: string }[]; accent?: boolean }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <p className="t-eyebrow text-bone-50/50">{title}</p>
        <p className="t-mono hidden text-bone-50/55 md:block">{note}</p>
      </div>
      <ol className="mt-4 grid gap-px overflow-hidden rounded-[3px] border border-bone-50/10 bg-bone-50/10 md:grid-flow-col md:auto-cols-fr">
        {nodes.map((n, i) => (
          <li key={n.id} className="relative bg-ink-950 p-4 md:p-5">
            <span className="t-mono text-bone-50/55">{String(i + 1).padStart(2, "0")}</span>
            <p className="mt-2 text-[0.9375rem] font-medium leading-snug">{n.label}</p>
            <p className="t-small mt-1 text-bone-50/50">{n.body}</p>
            {i < nodes.length - 1 ? (
              <span
                aria-hidden="true"
                className={`absolute -right-[7px] top-1/2 z-10 hidden size-3 -translate-y-1/2 rotate-45 border-r border-t md:block ${accent ? "border-signal bg-ink-950" : "border-bone-50/40 bg-ink-950"}`}
              />
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Planned split between safety-critical flight control and mission compute. */
export function FlightControlDiagram() {
  return (
    <div className="space-y-6">
      <Chain title="Companion computer — mission layer" note="Replaceable · upgradable" nodes={companionChain} />
      <div className="flex items-center gap-4 pl-4 md:pl-5">
        <span aria-hidden="true" className="h-10 w-px border-l border-dashed border-bone-50/40" />
        <p className="t-mono text-bone-50/50">Setpoints ↓ · Status & telemetry ↑</p>
      </div>
      <Chain title="Flight controller — real-time loop" note="Safety-critical · isolated" nodes={flightControlChain} accent />
    </div>
  );
}
