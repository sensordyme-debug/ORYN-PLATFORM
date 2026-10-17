/**
 * Audit trail writer. Audit rows are append-only (enforced in the database).
 * Call inside the same transaction as the change being audited so an action
 * and its audit record commit or roll back together.
 */
import type { Tx } from "@/server/db/client";
import { jsonb } from "@/server/db/client";

export type AuditActor =
  | { type: "user"; userId: string; label?: string | null }
  | { type: "api_key"; apiKeyId: string; label?: string | null }
  | { type: "system"; label: string };

export type AuditEntry = {
  orgId: string | null;
  actor: AuditActor;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
};

export async function recordAudit(tx: Tx, e: AuditEntry): Promise<void> {
  await tx`
    insert into audit_events
      (org_id, actor_type, actor_user_id, actor_api_key_id, actor_label, action, target_type, target_id, metadata, ip, user_agent)
    values (
      ${e.orgId},
      ${e.actor.type},
      ${e.actor.type === "user" ? e.actor.userId : null},
      ${e.actor.type === "api_key" ? e.actor.apiKeyId : null},
      ${e.actor.label ?? null},
      ${e.action},
      ${e.targetType ?? null},
      ${e.targetId ?? null},
      ${jsonb(e.metadata ?? {})}::jsonb,
      ${e.ip ?? null},
      ${e.userAgent ?? null}
    )`;
}

export type AuditEventView = {
  id: number;
  actorType: string;
  actorLabel: string | null;
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: Date;
};

/** Keyset-paginated audit listing for an org (requires audit.read, checked by the caller's access). */
export async function listAuditEvents(
  access: { org: { id: string }; assert(p: "audit.read"): void; tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> },
  opts: { before?: number; action?: string; actorUserId?: string; targetId?: string; limit?: number } = {},
): Promise<AuditEventView[]> {
  access.assert("audit.read");
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  return access.tx(async (tx) => {
    const rows = await tx<
      { id: string; actor_type: string; actor_label: string | null; actor_name: string | null; action: string; target_type: string | null; target_id: string | null; metadata: Record<string, unknown>; ip: string | null; created_at: Date }[]
    >`
      select e.id, e.actor_type, e.actor_label, u.name as actor_name, e.action, e.target_type, e.target_id, e.metadata, e.ip, e.created_at
        from audit_events e left join auth_user u on u.id = e.actor_user_id
       where e.org_id = ${access.org.id}
         ${opts.before ? tx`and e.id < ${opts.before}` : tx``}
         ${opts.action ? tx`and e.action like ${opts.action.replace(/[%_\\]/g, "\\$&") + "%"}` : tx``}
         ${opts.actorUserId ? tx`and e.actor_user_id = ${opts.actorUserId}` : tx``}
         ${opts.targetId ? tx`and e.target_id = ${opts.targetId}` : tx``}
       order by e.id desc
       limit ${limit}`;
    return rows.map((r) => ({
      id: Number(r.id),
      actorType: r.actor_type,
      actorLabel: r.actor_label,
      actorName: r.actor_name,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      metadata: r.metadata,
      ip: r.ip,
      createdAt: r.created_at,
    }));
  });
}
