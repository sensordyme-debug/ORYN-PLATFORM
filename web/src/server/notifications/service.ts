/**
 * In-app notification inbox for the UI.
 *
 * Guarantees
 *  - A user only ever sees their own notifications, for an org they are a
 *    member of, for alerts whose AOI they can still see (grants revoked
 *    after delivery hide the notification).
 */
import { uuidSchema } from "@/server/config/env";
import { withTenant } from "@/server/db/client";

export type InAppNotification = {
  id: string;
  alertId: string;
  title: string;
  severity: string;
  alertStatus: string;
  aoiId: string;
  aoiName: string;
  reason: string | null;
  createdAt: Date;
  sentAt: Date | null;
  readAt: Date | null;
};

export async function listNotifications(
  userId: string,
  orgId: string,
  unreadOnly = false,
  opts: { limit?: number } = {},
): Promise<InAppNotification[]> {
  if (!uuidSchema.safeParse(orgId).success) return [];
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  return withTenant({ orgId, userId }, async (tx) => {
    const rows = await tx<
      { id: string; alert_id: string; title: string; severity: string; alert_status: string; aoi_id: string; aoi_name: string; status_reason: string | null; created_at: Date; sent_at: Date | null; read_at: Date | null }[]
    >`
      select n.id, n.alert_id, a.title, a.severity, a.status as alert_status, a.aoi_id, ao.name as aoi_name,
             n.status_reason, n.created_at, n.sent_at, n.read_at
        from notifications n
        join memberships m on m.org_id = n.org_id and m.user_id = n.user_id
        join alerts a on a.id = n.alert_id
        join aois ao on ao.id = a.aoi_id
       where n.org_id = ${orgId} and n.user_id = ${userId} and n.channel = 'in_app' and n.status = 'sent'
         ${unreadOnly ? tx`and n.read_at is null` : tx``}
         and (not m.aoi_restricted or exists (select 1 from aoi_grants g where g.membership_id = m.id and g.aoi_id = a.aoi_id))
       order by coalesce(n.sent_at, n.created_at) desc, n.id desc
       limit ${limit}`;
    return rows.map((r) => ({
      id: r.id,
      alertId: r.alert_id,
      title: r.title,
      severity: r.severity,
      alertStatus: r.alert_status,
      aoiId: r.aoi_id,
      aoiName: r.aoi_name,
      reason: r.status_reason,
      createdAt: r.created_at,
      sentAt: r.sent_at,
      readAt: r.read_at,
    }));
  });
}

export async function unreadNotificationCount(userId: string, orgId: string): Promise<number> {
  return (await listNotifications(userId, orgId, true, { limit: 200 })).length;
}

/** Mark notifications read. With no ids, marks all of the user's unread in-app notifications in the org. Returns rows updated. */
export async function markRead(userId: string, orgId: string, notificationIds?: string[]): Promise<number> {
  if (!uuidSchema.safeParse(orgId).success) return 0;
  const ids = notificationIds?.filter((id) => uuidSchema.safeParse(id).success);
  if (ids && ids.length === 0) return 0;
  return withTenant({ orgId, userId }, async (tx) => {
    const rows = await tx`
      update notifications set read_at = now()
       where org_id = ${orgId} and user_id = ${userId} and channel = 'in_app' and read_at is null
         ${ids ? tx`and id = any(${ids}::uuid[])` : tx``}
      returning id`;
    return rows.length;
  });
}
