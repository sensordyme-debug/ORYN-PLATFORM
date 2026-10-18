import Link from "next/link";
import { CompleteOnboardingButton } from "@/components/platform/onboarding";
import { Badge, DataAge, EmptyState, EVIDENCE_TONE, LinkButton, Notice, PageHeader, Panel, SEVERITY_TONE, Stat, Table, td, th } from "@/components/platform/ui";
import { ageInDays, formatDate, formatDateTime, formatNumber, relativeTime } from "@/lib/format";
import { formatArea } from "@/lib/geo";
import { orgProfile } from "@/lib/org-profile";
import { sensorLabel } from "@/lib/sensors";
import { getOrgPageAccess } from "@/server/authz/next";
import { overviewData } from "@/server/results/overview";

export const metadata = { title: "Overview" };

export default async function OverviewPage(props: PageProps<"/app/[org]">) {
  const { org } = await props.params;
  const access = await getOrgPageAccess(org);
  const tz = access.org.settings.timezone ?? "UTC";
  const words = orgProfile(access.org.kind);
  const isAg = words.fieldHealth;

  const data = await overviewData(access);

  const s = data.stats;
  const showOnboarding = !access.org.onboardingCompletedAt && access.can("org.manage");
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={words.workspace}
        title={access.org.name}
        actions={<LinkButton href={`/app/${org}/map`} variant="primary">Open map workspace</LinkButton>}
      />

      {showOnboarding ? (
        <Panel title="Set up this workspace" description="A short checklist for administrators. Nothing is sent or created outside ORYN without your action.">
          <ol className="grid gap-2 text-[0.8125rem] md:grid-cols-2">
            <Step done={Boolean(access.org.settings.timezone)} href={`/app/${org}/settings`}>Confirm organization settings and time zone</Step>
            <Step done={s.aois > 0} href={`/app/${org}/areas/new`}>{isAg ? "Add your farm and field boundaries" : "Import your boundary and add areas of interest"}</Step>
            <Step done={false} href={`/app/${org}/sources`} optional>Review which data sources are available and licensed</Step>
            <Step done={s.rules > 0} href={`/app/${org}/alerts/rules`}>Configure alert rules</Step>
            <Step done={s.members > 1} href={`/app/${org}/settings/members`}>Invite your team</Step>
          </ol>
          <div className="mt-4"><CompleteOnboardingButton slug={org} /></div>
        </Panel>
      ) : null}

      <div className="grid grid-cols-2 gap-4 rounded-[4px] border border-bone-50/[0.09] bg-ink-850 p-4 md:grid-cols-5">
        <Stat label={words.areasStat} value={s.aois} />
        <Stat label="With data ≤ 10 days old" value={`${s.current} / ${s.aois}`} detail="usable satellite observation" />
        <Stat label="Open alerts" value={s.open_alerts} />
        <Stat label="Changes to review" value={s.unreviewed} detail="moderate or strong evidence" />
        <Stat label="Processing" value={s.queued} detail={s.failed ? `${s.failed} need attention` : "queued or running"} />
      </div>

      {data.warnings.length ? (
        <div className="flex flex-col gap-2">
          {data.warnings.map((w) => (
            <Notice key={w.id} tone="warn" title={`Official NWS warning — ${w.title}`}>
              {w.aoi_name}{w.severity ? ` · ${w.severity}` : ""}{w.event_end ? ` · until ${formatDateTime(w.event_end, tz)}` : ""}
            </Notice>
          ))}
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        {isAg ? (
          <Panel title="Field health" description="Latest usable NDVI per field and change from the previous usable image of the same sensor (Sentinel-2 and Landsat values are never compared). A drop can reflect harvest or seasonal change — check the field before acting." bodyClassName="p-0">
            {data.fields.length === 0 ? (
              <EmptyState title="No fields yet" className="m-4" action={access.can("aoi.write") ? <LinkButton href={`/app/${org}/areas/new`} variant="primary">Add fields</LinkButton> : undefined} />
            ) : (
              <Table label="Field health">
                <thead><tr><th className={th}>Field</th><th className={th}>NDVI</th><th className={th}>Change</th><th className={th}>Data age</th><th className={th}>Attention</th></tr></thead>
                <tbody>
                  {data.fields.map((f) => {
                    const delta = f.latest_mean !== null && f.prev_mean !== null ? f.latest_mean - f.prev_mean : null;
                    return (
                      <tr key={f.id}>
                        <td className={td}><Link href={`/app/${org}/map?aoi=${f.id}`} className="font-medium hover:underline">{f.name}</Link><span className="block text-[0.75rem] text-bone-50/55">{[f.crop, formatArea(f.area_m2)].filter(Boolean).join(" · ")}</span></td>
                        <td className={`${td} tabular-nums`}>{formatNumber(f.latest_mean, 2)}</td>
                        <td className={`${td} tabular-nums`}>
                          {delta === null ? "—" : <span className={delta <= -0.1 ? "text-data-alert" : delta >= 0.1 ? "text-data-veg" : ""}>{delta > 0 ? "+" : ""}{delta.toFixed(2)}</span>}
                          {f.prev_at ? <span className="block text-[0.6875rem] text-bone-50/55">vs {formatDate(f.prev_at, tz)} · {sensorLabel(f.latest_collection)}</span> : f.latest_at ? <span className="block text-[0.6875rem] text-bone-50/55">no earlier {sensorLabel(f.latest_collection)} image</span> : null}
                        </td>
                        <td className={td}>{f.latest_at ? <DataAge at={f.latest_at} timeZone={tz} /> : <span className="text-bone-50/55">No usable image</span>}</td>
                        <td className={td}>
                          <div className="flex flex-wrap gap-1">
                            {f.open_alerts ? <Badge tone="alert">{f.open_alerts} alert</Badge> : null}
                            {f.unreviewed ? <Badge tone="watch">{f.unreviewed} change</Badge> : null}
                            {f.latest_at && (ageInDays(f.latest_at) ?? 0) > 20 ? <Badge tone="muted">stale</Badge> : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Panel>
        ) : (
          <Panel title="Candidate changes awaiting review" description="Computed from satellite observations; each needs verification before it is treated as a real-world change." actions={<LinkButton size="sm" href={`/app/${org}/detections`}>{words.review}</LinkButton>} bodyClassName="p-0">
            {data.changes.length === 0 ? (
              <EmptyState title="Nothing to review" className="m-4">Candidate changes appear after two usable observations of an area are compared.</EmptyState>
            ) : (
              <Table label="Candidate changes awaiting review">
                <tbody>
                  {data.changes.map((c) => (
                    <tr key={c.id}>
                      <td className={td}><Link className="hover:underline" href={`/app/${org}/map?detection=${c.id}`}>{c.title}</Link><span className="block text-[0.75rem] text-bone-50/55">{c.aoi_name} · {c.area_m2 ? formatArea(c.area_m2) : ""}</span></td>
                      <td className={td}><Badge tone={EVIDENCE_TONE[c.evidence_grade]}>{c.evidence_grade}</Badge></td>
                      <td className={`${td} whitespace-nowrap`}>{c.comparison_observed_at ? formatDate(c.comparison_observed_at, tz) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>
        )}

        <div className="flex flex-col gap-6">
          <Panel title="Open alerts" actions={<LinkButton size="sm" href={`/app/${org}/alerts`}>All alerts</LinkButton>} bodyClassName="p-0">
            {data.alerts.length === 0 ? (
              <EmptyState title="No open alerts" className="m-4">{s.rules === 0 ? "No alert rules are configured yet." : "Rules are evaluated when new data is processed, when a rule changes, and every 6 hours."}</EmptyState>
            ) : (
              <ul>
                {data.alerts.map((a) => (
                  <li key={a.id} className="border-b border-bone-50/[0.05] px-4 py-2.5 text-[0.8125rem]">
                    <div className="flex items-start justify-between gap-2">
                      <Link href={`/app/${org}/alerts/${a.id}`} className="hover:underline">{a.title}</Link>
                      <Badge tone={SEVERITY_TONE[a.severity] ?? "neutral"}>{a.severity}</Badge>
                    </div>
                    <p className="text-[0.75rem] text-bone-50/55">
                      {a.aoi_name} · data acquired {a.observed_at ? relativeTime(a.observed_at) : "—"} · alerted {relativeTime(a.created_at)}{a.from_reprocessing ? " · from reprocessing" : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          {!isAg ? (
            <Panel title="News reports" description="Claims published by news outlets that mention your areas. Not verified events.">
              {data.news.length === 0 ? (
                <p className="text-[0.8125rem] text-bone-50/50">No matching reports. News matching runs for areas with search terms configured.</p>
              ) : (
                <ul className="flex flex-col gap-2 text-[0.8125rem]">
                  {data.news.map((n) => (
                    <li key={n.url}>
                      <a href={n.url} target="_blank" rel="noreferrer" className="hover:underline">{n.title}</a>
                      <span className="block text-[0.75rem] text-bone-50/55">{n.domain} · {n.category} · {n.aoi_name} · {n.published_at ? formatDate(n.published_at, tz) : "date unknown"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Step({ done, href, children, optional }: { done: boolean; href: string; children: React.ReactNode; optional?: boolean }) {
  return (
    <li className="flex items-center gap-2">
      <span aria-hidden="true" className={done ? "text-data-veg" : "text-bone-50/30"}>{done ? "✓" : "○"}</span>
      <Link href={href} className="hover:underline">{children}</Link>
      {done ? <span className="sr-only">(done)</span> : optional ? <span className="text-[0.6875rem] text-bone-50/55">recommended</span> : null}
    </li>
  );
}
