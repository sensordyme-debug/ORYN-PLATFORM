/**
 * Geographic access scope shared by alerts, notifications, reports, and
 * exports. Members with aoi_restricted = true see only AOIs granted to their
 * membership in aoi_grants; everyone else in the org sees every AOI.
 *
 * Callers run inside the org's tenant transaction, so RLS already limits
 * rows to the org; this narrows further to the member's granted AOIs.
 */
import type { OrgAccess } from "@/server/authz/access";
import type { Tx } from "@/server/db/client";

/** AOI ids the principal may see, or null when unrestricted. */
export async function visibleAoiIds(tx: Tx, access: OrgAccess): Promise<string[] | null> {
  if (!access.aoiRestricted) return null;
  if (!access.membershipId) return [];
  const rows = await tx<{ aoi_id: string }[]>`
    select aoi_id from aoi_grants where org_id = ${access.org.id} and membership_id = ${access.membershipId}`;
  return rows.map((r) => r.aoi_id);
}

export async function canSeeAoi(tx: Tx, access: OrgAccess, aoiId: string): Promise<boolean> {
  const ids = await visibleAoiIds(tx, access);
  return ids === null || ids.includes(aoiId);
}

/** Whether a given membership (by user) can see an AOI — used for recipients and assignees. */
export async function memberCanSeeAoi(tx: Tx, orgId: string, userId: string, aoiId: string): Promise<boolean> {
  const [row] = await tx<{ ok: boolean }[]>`
    select (not m.aoi_restricted or exists (
              select 1 from aoi_grants g where g.membership_id = m.id and g.aoi_id = ${aoiId})) as ok
      from memberships m
     where m.org_id = ${orgId} and m.user_id = ${userId}`;
  return row?.ok ?? false;
}
