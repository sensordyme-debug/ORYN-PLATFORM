"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { importBoundaryAction, searchBoundariesAction } from "@/app/(platform)/app/[org]/areas/actions";
import { Button, Field, inputClass, Notice } from "@/components/platform/ui";
import { formatArea } from "@/lib/geo";

const STATES: [string, string][] = [
  ["01", "AL"], ["02", "AK"], ["04", "AZ"], ["05", "AR"], ["06", "CA"], ["08", "CO"], ["09", "CT"], ["10", "DE"], ["11", "DC"], ["12", "FL"],
  ["13", "GA"], ["15", "HI"], ["16", "ID"], ["17", "IL"], ["18", "IN"], ["19", "IA"], ["20", "KS"], ["21", "KY"], ["22", "LA"], ["23", "ME"],
  ["24", "MD"], ["25", "MA"], ["26", "MI"], ["27", "MN"], ["28", "MS"], ["29", "MO"], ["30", "MT"], ["31", "NE"], ["32", "NV"], ["33", "NH"],
  ["34", "NJ"], ["35", "NM"], ["36", "NY"], ["37", "NC"], ["38", "ND"], ["39", "OH"], ["40", "OK"], ["41", "OR"], ["42", "PA"], ["44", "RI"],
  ["45", "SC"], ["46", "SD"], ["47", "TN"], ["48", "TX"], ["49", "UT"], ["50", "VT"], ["51", "VA"], ["53", "WA"], ["54", "WV"], ["55", "WI"], ["56", "WY"],
];

type Hit = { geoid: string; name: string; kind: string; areaLandM2: number | null };

export function BoundaryImport({ slug }: { slug: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [state, setState] = useState("37");
  const [level, setLevel] = useState<"place" | "county">("place");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          setError(null);
          const r = await searchBoundariesAction(slug, { name, stateFips: state, level });
          setPending(false);
          if (r.ok) setHits(r.data);
          else setError(r.error);
        }}
      >
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Field label="Name" htmlFor="b-name"><input id="b-name" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} className={inputClass} placeholder="Tarboro" /></Field>
          <Field label="State" htmlFor="b-state">
            <select id="b-state" value={state} onChange={(e) => setState(e.target.value)} className={inputClass}>{STATES.map(([f, a]) => <option key={f} value={f}>{a}</option>)}</select>
          </Field>
        </div>
        <div className="flex gap-3 text-[0.8125rem]">
          <label className="flex items-center gap-1.5"><input type="radio" checked={level === "place"} onChange={() => setLevel("place")} /> City / town / CDP</label>
          <label className="flex items-center gap-1.5"><input type="radio" checked={level === "county"} onChange={() => setLevel("county")} /> County</label>
        </div>
        <Button type="submit" disabled={pending}>{pending ? "Searching…" : "Search Census boundaries"}</Button>
      </form>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {hits && hits.length === 0 ? <p className="text-[0.8125rem] text-bone-50/55">No exact match. Census names are exact (e.g. “Tarboro”, not “Tarboro, NC”).</p> : null}
      {hits?.map((h) => (
        <div key={h.geoid} className="flex items-center justify-between gap-2 rounded-[3px] border border-bone-50/10 px-3 py-2 text-[0.8125rem]">
          <span>
            {h.name}
            <span className="block text-[0.6875rem] text-bone-50/45">GEOID {h.geoid} · {h.kind.replace(/_/g, " ")}{h.areaLandM2 ? ` · land ${formatArea(h.areaLandM2)}` : ""}</span>
          </span>
          <Button
            size="sm"
            variant="primary"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              const r = await importBoundaryAction(slug, {
                geoid: h.geoid,
                level,
                name: h.name,
                kind: level === "county" ? "region" : "municipal_boundary",
                newsTerms: [h.name.replace(/ (town|city|village|CDP|County)$/i, "")],
              });
              setPending(false);
              if (r.ok) router.push(`/app/${slug}/areas/${r.data.id}`);
              else setError(r.error);
            }}
          >
            Import
          </Button>
        </div>
      ))}
    </div>
  );
}
