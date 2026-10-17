import Link from "next/link";
import { CompleteOnboardingButton } from "@/components/platform/onboarding";
import { Badge, DataAge, EmptyState, EVIDENCE_TONE, LinkButton, Notice, PageHeader, Panel, SEVERITY_TONE, Stat, Table, td, th } from "@/components/platform/ui";
import { ageInDays, formatDate, formatDateTime, formatNumber, relativeTime } from "@/lib/format";
import { formatArea } from "@/lib/geo";
import { aoiVisibleTo } from "@/server/aois/service";
import { currentModelKeys } from "@/server/analytics/registry";
import { getOrgPageAccess } from "@/server/authz/next";

export const metadata = { title: "Overview" };

type FieldRow = { id: string; name: string; area_m2: number; crop: string | null; latest_at: Date | null; latest_mean: number | null; prev_mean: number | null; prev_at: Date | null; masked: number | null; open_alerts: number; unreviewed: number };

export default async function OverviewPage(props: PageProps<"/app/[org]">) {
  const { org } = await props.params;
  const access = await getOrgPageAccess(org);
  const tz = access.org.settings.timezone ?? "UTC";
  const isAg = access.org.kind === "agriculture";

  const data = await access.tx(async (tx) => {
    const [stats] = await tx<{ aois: number; current: number; open_alerts: number; unreviewed: number; queued: number; failed: number; rules: number; members: number }[]>`
      select
        (select count(*)::int from aois a where a.org_id = ${access.org.id} and a.status = 'active' ${aoiVisibleTo(tx, access)}) as aois,
        (select count(distinct o.aoi_id)::int from observations o join aois a on a.id = o.aoi_id
          where o.org_id = ${access.org.id} and o.status = 'valid' and o.is_current and o.observed_at > now() - interval '10 days' ${aoiVisibleTo(tx, access)}) as current,
        (select count(*)::int from alerts where org_id = ${access.org.id} and status = 'open') as open_alerts,
        (select count(*)::int from detections where org_id = ${access.org.id} and verification_status = 'unverified' and evidence_grade in ('moderate', 'strong')
            and model_id || '@' || model_version = any(${currentModelKeys()})) as unreviewed,
        (select count(*)::int from jobs where org_id = ${access.org.id} and status in ('queued', 'running')) as queued,
        (select count(*)::int from jobs where org_id = ${access.org.id} and status in ('failed', 'dead')) as failed,
        (select count(*)::int from alert_rules where org_id = ${access.org.id} and enabled) as rules,
        (select count(*)::int from memberships where org_id = ${access.org.id}) as members`;
    const alerts = await tx<{ id: string; title: string; severity: string; status: string; observed_at: Date | null; created_at: Date; aoi_name: string; from_reprocessing: boolean }[]>`
      select al.id, al.title, al.severity, al.status, al.observed_at, al.created_at, a.name as aoi_name, al.from_reprocessing
        from alerts al join aois a on a.id = al.aoi_id
       where al.org_id = ${access.org.id} and al.status in ('open', 'acknowledged') ${aoiVisibleTo(tx, access)}
       order by case al.severity when 'critical' then 0 when 'high' then 1 when 'moderate' then 2 when 'low' then 3 else 4 end, al.created_at desc
       limit 8`;
    const fields = isAg
      ? await tx<FieldRow[]>`
          select a.id, a.name, a.area_m2, a.metadata->>'crop' as crop, l.observed_at as latest_at, (l.metrics->>'mean')::float8 as latest_mean,
                 (p.metrics->>'mean')::float8 as prev_mean, p.observed_at as prev_at, (l.quality->>'masked_fraction')::float8 as masked,
                 (select count(*)::int from alerts al where al.aoi_id = a.id and al.status in ('open','acknowledged')) as open_alerts,
                 (select count(*)::int from detections d where d.aoi_id = a.id and d.verification_status = 'unverified'
                    and d.evidence_grade in ('moderate', 'strong') and d.model_id || '@' || d.model_version = any(${currentModelKeys()})) as unreviewed
            from aois a
            left join lateral (select * from observations o where o.aoi_id = a.id and o.kind = 'ndvi' and o.status = 'valid' and o.is_current order by o.observed_at desc limit 1) l on true
            left join lateral (select * from observations o where o.aoi_id = a.id and o.kind = 'ndvi' and o.status = 'valid' and o.is_current and o.observed_at < l.observed_at order by o.observed_at desc limit 1) p on true
           where a.org_id = ${access.org.id} and a.status = 'active' and a.kind = 'field' ${aoiVisibleTo(tx, access)}
           order by a.name`
      : [];
    const changes = await tx<{ id: string; title: string; type: string; evidence_grade: string; area_m2: number | null; comparison_observed_at: Date | null; aoi_name: string }[]>`
      select d.id, d.title, d.type, d.evidence_grade, d.area_m2, d.comparison_observed_at, a.name as aoi_name
        from detections d join aois a on a.id = d.aoi_id
       where d.org_id = ${access.org.id} and d.verification_status in ('unverified', 'needs_field_check') and d.evidence_grade in ('moderate', 'strong')
         and d.model_id || '@' || d.model_version = any(${currentModelKeys()}) ${aoiVisibleTo(tx, access)}
       order by d.comparison_observed_at desc nulls last limit 8`;
    const warnings = await tx<{ id: string; title: string; severity: string | null; event_end: Date | null; aoi_name: string }[]>`
      select distinct on (e.external_id) e.id, e.title, e.severity, e.event_end, a.name as aoi_name
        from external_events e join aois a on a.id = e.aoi_id
       where e.org_id = ${access.org.id} and e.event_kind = 'weather_warning' and (e.event_end is null or e.event_end > now())
       order by e.external_id, e.published_at desc limit 6`;
    const news = !isAg
      ? await tx<{ title: string; url: string; domain: string | null; published_at: Date | null; category: string; aoi_name: string }[]>`
          select n.title, n.url, n.domain, n.published_at, m.category, a.name as aoi_name
            from aoi_news_matches m join news_articles n on n.id = m.article_id join aois a on a.id = m.aoi_id
           where m.org_id = ${access.org.id} order by n.published_at desc nulls last limit 6`
      : [];
    return { stats: stats!, alerts, fields, changes, warnings, news };
  });

  const s = data.stats;
  const showOnboarding = !access.org.onboardingCompletedAt && access.can("org.manage");
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={isAg ? "Agricultural workspace" : access.org.kind === "municipal" ? "Municipal workspace" : "Workspace"}
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
        <Stat label={isAg ? "Monitored areas" : "Areas of interest"} value={s.aois} />
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
          <Panel title="Field health" description="Latest usable NDVI per field and change from the previous usable image. A drop can reflect harvest or seasonal change — check the field before acting." bodyClassName="p-0">
            {data.fields.length === 0 ? (
              <EmptyState title="No fields yet" className="m-4" action={access.can("aoi.write") ? <LinkButton href={`/app/${org}/areas/new`} variant="primary">Add fields</LinkButton> : undefined} />
            ) : (
              <Table>
                <thead><tr><th className={th}>Field</th><th className={th}>NDVI</th><th className={th}>Change</th><th className={th}>Data age</th><th className={th}>Attention</th></tr></thead>
                <tbody>
                  {data.fields.map((f) => {
                    const delta = f.latest_mean !== null && f.prev_mean !== null ? f.latest_mean - f.prev_mean : null;
                    return (
                      <tr key={f.id}>
                        <td className={td}><Link href={`/app/${org}/map?aoi=${f.id}`} className="font-medium hover:underline">{f.name}</Link><span className="block text-[0.75rem] text-bone-50/45">{[f.crop, formatArea(f.area_m2)].filter(Boolean).join(" · ")}</span></td>
                        <td className={`${td} tabular-nums`}>{formatNumber(f.latest_mean, 2)}</td>
                        <td className={`${td} tabular-nums`}>
                          {delta === null ? "—" : <span className={delta <= -0.1 ? "text-data-alert" : delta >= 0.1 ? "text-data-veg" : ""}>{delta > 0 ? "+" : ""}{delta.toFixed(2)}</span>}
                          {f.prev_at ? <span className="block text-[0.6875rem] text-bone-50/40">vs {formatDate(f.prev_at, tz)}</span> : null}
                        </td>
                        <td className={td}>{f.latest_at ? <DataAge at={f.latest_at} timeZone={tz} /> : <span className="text-bone-50/45">No usable image</span>}</td>
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
          <Panel title="Candidate changes awaiting review" description="Computed from satellite observations; each needs verification before it is treated as a real-world change." actions={<LinkButton size="sm" href={`/app/${org}/detections`}>Inspection queue</LinkButton>} bodyClassName="p-0">
            {data.changes.length === 0 ? (
              <EmptyState title="Nothing to review" className="m-4">Candidate changes appear after two usable observations of an area are compared.</EmptyState>
            ) : (
              <Table>
                <tbody>
                  {data.changes.map((c) => (
                    <tr key={c.id}>
                      <td className={td}><Link className="hover:underline" href={`/app/${org}/map?detection=${c.id}`}>{c.title}</Link><span className="block text-[0.75rem] text-bone-50/45">{c.aoi_name} · {c.area_m2 ? formatArea(c.area_m2) : ""}</span></td>
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
              <EmptyState title="No open alerts" className="m-4">{s.rules === 0 ? "No alert rules are configured yet." : "Rules are evaluated whenever new data is processed."}</EmptyState>
            ) : (
              <ul>
                {data.alerts.map((a) => (
                  <li key={a.id} className="border-b border-bone-50/[0.05] px-4 py-2.5 text-[0.8125rem]">
                    <div className="flex items-start justify-between gap-2">
                      <Link href={`/app/${org}/alerts/${a.id}`} className="hover:underline">{a.title}</Link>
                      <Badge tone={SEVERITY_TONE[a.severity] ?? "neutral"}>{a.severity}</Badge>
                    </div>
                    <p className="text-[0.75rem] text-bone-50/45">
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
                      <span className="block text-[0.75rem] text-bone-50/45">{n.domain} · {n.category} · {n.aoi_name} · {n.published_at ? formatDate(n.published_at, tz) : "date unknown"}</span>
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
      {done ? <span className="sr-only">(done)</span> : optional ? <span className="text-[0.6875rem] text-bone-50/40">recommended</span> : null}
    </li>
  );
}
