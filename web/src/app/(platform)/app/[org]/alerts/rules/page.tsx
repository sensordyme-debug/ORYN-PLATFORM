import Link from "next/link";
import { RuleControls } from "@/components/platform/alert-controls";
import { RuleForm } from "@/components/platform/rule-form";
import { Badge, EmptyState, PageHeader, Panel, SEVERITY_TONE, Table, td, th } from "@/components/platform/ui";
import { listAlertRules } from "@/server/alerts/rule-service";
import { ruleCatalog } from "@/server/alerts/rules";
import { listAois } from "@/server/aois/service";
import { getOrgPageAccess } from "@/server/authz/next";

export const metadata = { title: "Alert rules" };

export default async function RulesPage(props: PageProps<"/app/[org]/alerts/rules">) {
  const { org } = await props.params;
  const access = await getOrgPageAccess(org);
  const manage = access.can("alert_rules.manage");
  const [rules, aois] = await Promise.all([listAlertRules(access, { includeDisabled: true }), manage ? listAois(access, { limit: 500 }) : Promise.resolve({ items: [] })]);
  const catalog = ruleCatalog(access.org.kind as never);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow={<Link href={`/app/${org}/alerts`} className="hover:underline">Alerts</Link>} title="Alert rules" description="Rules are evaluated whenever new results arrive. A rule never fires on missing or insufficient data — it records why it could not evaluate instead." />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <Panel bodyClassName="p-0">
          {rules.length === 0 ? <EmptyState title="No rules yet" className="m-4">Without rules, ORYN records results but raises no alerts.</EmptyState> : (
            <Table>
              <thead><tr><th className={th}>Rule</th><th className={th}>Applies to</th><th className={th}>Severity</th><th className={th}>Parameters</th><th className={th} /></tr></thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id} className={r.enabled ? undefined : "opacity-50"}>
                    <td className={td}><span className="font-medium">{r.name}</span><span className="block text-[0.75rem] text-bone-50/45">{catalog.find((c) => c.type === r.ruleType)?.label ?? r.ruleType}{r.enabled ? "" : " · disabled"}</span></td>
                    <td className={td}>{r.aoiName ?? "All areas"}</td>
                    <td className={td}><Badge tone={SEVERITY_TONE[r.severity] ?? "neutral"}>{r.severity}</Badge></td>
                    <td className={td}><code className="text-[0.6875rem] text-bone-50/65">{JSON.stringify(r.params)}</code><span className="block text-[0.6875rem] text-bone-50/40">cooldown {r.cooldownHours} h{r.escalateAfterHours ? ` · escalate after ${r.escalateAfterHours} h` : ""}{r.notifyEmail ? " · email" : ""}</span></td>
                    <td className={td}>{manage ? <RuleControls slug={org} ruleId={r.id} enabled={r.enabled} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
        {manage ? <Panel title="New rule"><RuleForm slug={org} catalog={catalog as never} aois={aois.items.map((a) => ({ id: a.id, name: a.name }))} /></Panel> : null}
      </div>
    </div>
  );
}
