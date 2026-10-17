/**
 * Per-request summary for the organization shell: navigation badges and
 * whether the org holds test-fixture measurements (so the banner never calls
 * fixture rows real). Counts follow the caller's AOI scope.
 */
import { FIXTURE_PROVIDER_ID } from "@/lib/fixtures";
import { currentModelKeys } from "@/server/analytics/registry";
import type { OrgAccess } from "@/server/authz/access";
import { aoiVisibleTo } from "@/server/aois/service";

export type ShellSummary = { unread: number; open_alerts: number; unreviewed: number; has_fixture_data: boolean };

export async function shellSummary(access: OrgAccess, userId: string): Promise<ShellSummary> {
  return access.tx(async (tx) => {
    const [r] = await tx<ShellSummary[]>`
      select
        (select count(*)::int from notifications n where n.org_id = ${access.org.id} and n.user_id = ${userId} and n.channel = 'in_app' and n.read_at is null) as unread,
        (select count(*)::int from alerts al join aois a on a.id = al.aoi_id
          where al.org_id = ${access.org.id} and al.status = 'open' ${aoiVisibleTo(tx, access)}) as open_alerts,
        (select count(*)::int from detections d join aois a on a.id = d.aoi_id
          where d.org_id = ${access.org.id} and d.verification_status = 'unverified' and d.evidence_grade in ('moderate', 'strong')
            and d.model_id || '@' || d.model_version = any(${currentModelKeys()}) ${aoiVisibleTo(tx, access)}) as unreviewed,
        exists (select 1 from observations o join source_assets s on s.id = o.asset_id
                 where o.org_id = ${access.org.id} and s.provider_id = ${FIXTURE_PROVIDER_ID}) as has_fixture_data`;
    return r!;
  });
}
