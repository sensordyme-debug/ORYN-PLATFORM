/**
 * Read models for the organization overview page.
 *
 * Field health compares an area's latest usable NDVI with the previous usable
 * NDVI from the SAME collection and an earlier satellite pass. Values from
 * different sensors (Sentinel-2 vs Landsat) are not comparable — their bands,
 * resolution and atmospheric correction differ — and two tiles of one pass
 * are the same acquisition, not a change over time.
 */
import { currentModelKeys } from "@/server/analytics/registry";
import type { OrgAccess } from "@/server/authz/access";
import { aoiVisibleTo } from "@/server/aois/service";
import type { Tx } from "@/server/db/client";

/** Observations closer together than this are treated as one satellite pass. */
export const SAME_PASS_WINDOW = "1 hour";

export type FieldHealthRow = {
  id: string;
  name: string;
  area_m2: number;
  crop: string | null;
  latest_at: Date | null;
  latest_mean: number | null;
  latest_collection: string | null;
  latest_platform: string | null;
  prev_mean: number | null;
  prev_at: Date | null;
  masked: number | null;
  open_alerts: number;
  unreviewed: number;
};

export async function fieldHealth(tx: Tx, access: OrgAccess, modelKeys: string[]): Promise<FieldHealthRow[]> {
  return tx<FieldHealthRow[]>`
    select a.id, a.name, a.area_m2, a.metadata->>'crop' as crop, l.observed_at as latest_at, (l.metrics->>'mean')::float8 as latest_mean,
           l.collection as latest_collection, l.platform as latest_platform,
           (p.metrics->>'mean')::float8 as prev_mean, p.observed_at as prev_at, (l.quality->>'masked_fraction')::float8 as masked,
           (select count(*)::int from alerts al where al.aoi_id = a.id and al.status in ('open','acknowledged')) as open_alerts,
           (select count(*)::int from detections d where d.aoi_id = a.id and d.verification_status = 'unverified'
              and d.evidence_grade in ('moderate', 'strong') and d.model_id || '@' || d.model_version = any(${modelKeys})) as unreviewed
      from aois a
      left join lateral (
        select o.observed_at, o.metrics, o.quality, s.collection, s.platform
          from observations o join source_assets s on s.id = o.asset_id
         where o.aoi_id = a.id and o.kind = 'ndvi' and o.status = 'valid' and o.is_current
         order by o.observed_at desc limit 1) l on true
      left join lateral (
        select o.observed_at, o.metrics
          from observations o join source_assets s on s.id = o.asset_id
         where o.aoi_id = a.id and o.kind = 'ndvi' and o.status = 'valid' and o.is_current
           and s.collection = l.collection and o.observed_at < l.observed_at - ${SAME_PASS_WINDOW}::interval
         order by o.observed_at desc limit 1) p on true
     where a.org_id = ${access.org.id} and a.status = 'active' and a.kind = 'field' ${aoiVisibleTo(tx, access)}
     order by a.name`;
}

/** Everything the overview page shows, scoped to the caller's visible AOIs. */
export async function overviewData(access: OrgAccess) {
  const isAg = access.org.kind === "agriculture";
  return access.tx(async (tx) => {
    const [stats] = await tx<{ aois: number; current: number; open_alerts: number; unreviewed: number; queued: number; failed: number; rules: number; members: number }[]>`
      select
        (select count(*)::int from aois a where a.org_id = ${access.org.id} and a.status = 'active' ${aoiVisibleTo(tx, access)}) as aois,
        (select count(distinct o.aoi_id)::int from observations o join aois a on a.id = o.aoi_id
          where o.org_id = ${access.org.id} and o.status = 'valid' and o.is_current and o.observed_at > now() - interval '10 days' ${aoiVisibleTo(tx, access)}) as current,
        (select count(*)::int from alerts al join aois a on a.id = al.aoi_id
          where al.org_id = ${access.org.id} and al.status = 'open' ${aoiVisibleTo(tx, access)}) as open_alerts,
        (select count(*)::int from detections d join aois a on a.id = d.aoi_id
          where d.org_id = ${access.org.id} and d.verification_status = 'unverified' and d.evidence_grade in ('moderate', 'strong')
            and d.model_id || '@' || d.model_version = any(${currentModelKeys()}) ${aoiVisibleTo(tx, access)}) as unreviewed,
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
    const fields = isAg ? await fieldHealth(tx, access, currentModelKeys()) : [];
    const changes = await tx<{ id: string; title: string; type: string; evidence_grade: string; area_m2: number | null; comparison_observed_at: Date | null; aoi_name: string }[]>`
      select d.id, d.title, d.type, d.evidence_grade, d.area_m2, d.comparison_observed_at, a.name as aoi_name
        from detections d join aois a on a.id = d.aoi_id
       where d.org_id = ${access.org.id} and d.verification_status in ('unverified', 'needs_field_check') and d.evidence_grade in ('moderate', 'strong')
         and d.model_id || '@' || d.model_version = any(${currentModelKeys()}) ${aoiVisibleTo(tx, access)}
       order by d.comparison_observed_at desc nulls last limit 8`;
    const warnings = await tx<{ id: string; title: string; severity: string | null; event_end: Date | null; aoi_name: string }[]>`
      select distinct on (e.external_id) e.id, e.title, e.severity, e.event_end, a.name as aoi_name
        from external_events e join aois a on a.id = e.aoi_id
       where e.org_id = ${access.org.id} and e.event_kind = 'weather_warning' and (e.event_end is null or e.event_end > now()) ${aoiVisibleTo(tx, access)}
       order by e.external_id, e.published_at desc limit 6`;
    const news = !isAg
      ? await tx<{ title: string; url: string; domain: string | null; published_at: Date | null; category: string; aoi_name: string }[]>`
          select n.title, n.url, n.domain, n.published_at, m.category, a.name as aoi_name
            from aoi_news_matches m join news_articles n on n.id = m.article_id join aois a on a.id = m.aoi_id
           where m.org_id = ${access.org.id} ${aoiVisibleTo(tx, access)} order by n.published_at desc nulls last limit 6`
      : [];
    return { stats: stats!, alerts, fields, changes, warnings, news };
  });
}
