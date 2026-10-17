import Link from "next/link";
import { DetectionSwatch } from "@/components/map/legend";
import { Badge, EmptyState, EVIDENCE_TONE, PageHeader, Panel, Table, td, th, VERIFICATION_TONE } from "@/components/platform/ui";
import { formatDate } from "@/lib/format";
import { formatArea } from "@/lib/geo";
import { getOrgPageAccess } from "@/server/authz/next";
import { detectionFeatures } from "@/server/results/service";

export const metadata = { title: "Change review" };

const VIEWS = {
  queue: { label: "To review", verification: ["unverified", "needs_field_check"] as const },
  field: { label: "Needs field check", verification: ["needs_field_check"] as const },
  confirmed: { label: "Confirmed", verification: ["confirmed"] as const },
  dismissed: { label: "Dismissed", verification: ["dismissed"] as const },
};

export default async function DetectionsPage(props: PageProps<"/app/[org]/detections">) {
  const { org } = await props.params;
  const sp = await props.searchParams;
  const access = await getOrgPageAccess(org);
  const tz = access.org.settings.timezone ?? "UTC";
  const view = (typeof sp.view === "string" && sp.view in VIEWS ? sp.view : "queue") as keyof typeof VIEWS;
  // Default to moderate-or-stronger evidence; weak candidates are listed on request and counted.
  const grade = sp.grade === "any" ? undefined : sp.grade === "strong" || sp.grade === "weak" ? sp.grade : "moderate";
  const fc = await detectionFeatures(access, { verification: [...VIEWS[view].verification], minGrade: grade, limit: 500 });
  const hidden = grade && grade !== "weak" ? (await detectionFeatures(access, { verification: [...VIEWS[view].verification], limit: 2000 })).features.length - fc.features.length : 0;
  const isMunicipal = access.org.kind !== "agriculture";
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Review"
        title={isMunicipal ? "Inspection queue" : "Change review"}
        description="Candidate changes found by comparing satellite observations. A candidate is not a finding about any property or person: it marks where measurements changed and needs review — and often a field check — before it is treated as real."
      />
      <div className="flex flex-wrap items-center gap-3 text-[0.8125rem]">
        <nav aria-label="Review status" className="flex gap-1">
          {Object.entries(VIEWS).map(([k, v]) => (
            <Link key={k} href={`/app/${org}/detections?view=${k}&grade=${grade ?? "any"}`} aria-current={view === k ? "page" : undefined} className={`rounded-[3px] px-2.5 py-1 ${view === k ? "bg-bone-50/[0.08]" : "text-bone-50/55 hover:text-bone-50"}`}>{v.label}</Link>
          ))}
        </nav>
        <span className="text-bone-50/40">|</span>
        {(["moderate", "strong", "any"] as const).map((g) => (
          <Link key={g} href={`/app/${org}/detections?view=${view}&grade=${g}`} className={(grade ?? "any") === g ? "text-bone-50" : "text-bone-50/55 hover:text-bone-50"}>{g === "any" ? "include weak evidence" : `${g}+ evidence`}</Link>
        ))}
      </div>
      {hidden > 0 ? <p className="-mt-3 text-[0.75rem] text-bone-50/45">{hidden} weak-evidence candidate{hidden === 1 ? " is" : "s are"} hidden. Weak candidates are usually seasonal change, haze, or mask edges.</p> : null}
      <Panel bodyClassName="p-0">
        {fc.features.length === 0 ? (
          <EmptyState title="Nothing in this list" className="m-4">Candidates appear after two usable observations of an area are compared.</EmptyState>
        ) : (
          <Table>
            <thead><tr><th className={th}>Candidate</th><th className={th}>Area</th><th className={th}>Compared</th><th className={th}>Evidence</th><th className={th}>Status</th></tr></thead>
            <tbody>
              {fc.features.map((f) => {
                const p = f.properties as { id: string; title: string; type: string; aoi_name: string; area_m2: number | null; baseline_observed_at: string | null; comparison_observed_at: string | null; evidence_grade: string; verification_status: string; model: string };
                return (
                  <tr key={p.id}>
                    <td className={td}>
                      <span className="mr-2 inline-flex align-middle"><DetectionSwatch type={p.type} /></span>
                      <Link className="font-medium hover:underline" href={`/app/${org}/map?detection=${p.id}`}>{p.title}</Link>
                      <span className="block text-[0.75rem] text-bone-50/45">{p.aoi_name} · {p.model}</span>
                    </td>
                    <td className={`${td} whitespace-nowrap`}>{p.area_m2 ? formatArea(p.area_m2) : "—"}</td>
                    <td className={`${td} whitespace-nowrap`}>{p.baseline_observed_at ? formatDate(p.baseline_observed_at, tz) : "—"} → {p.comparison_observed_at ? formatDate(p.comparison_observed_at, tz) : "—"}</td>
                    <td className={td}><Badge tone={EVIDENCE_TONE[p.evidence_grade]}>{p.evidence_grade}</Badge></td>
                    <td className={td}><Badge tone={VERIFICATION_TONE[p.verification_status]}>{p.verification_status.replace(/_/g, " ")}</Badge></td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Panel>
    </div>
  );
}
