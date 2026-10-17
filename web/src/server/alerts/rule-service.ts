/**
 * Alert rule management: create, update, enable/disable, delete, list.
 *
 * Guarantees
 *  - Mutations require alert_rules.manage; reads require alerts.read.
 *  - Parameters are validated and normalized with the catalog schema of the
 *    rule type (rules.ts) before they are stored; the rule type must apply to
 *    the organization's kind.
 *  - An AOI-scoped rule's AOI must belong to the organization and be visible
 *    to the caller; aoi_restricted members may only manage rules for AOIs
 *    granted to them (never org-wide rules).
 *  - Every mutation is audited in the same transaction.
 */
import { z } from "zod";
import { ORG_ROLES, type OrgRole } from "@/lib/authz";
import type { OrgAccess } from "@/server/authz/access";
import { recordAudit } from "@/server/audit";
import { uuidSchema } from "@/server/config/env";
import { jsonb, type Tx } from "@/server/db/client";
import { DomainError, notFoundError } from "@/server/errors";
import { isRuleType, parseRuleParams, RULE_TYPES, SEVERITIES, type RuleTypeId, type Severity } from "@/server/alerts/rules";
import { visibleAoiIds } from "@/server/alerts/scope";

export type AlertRule = {
  id: string;
  name: string;
  description: string;
  aoiId: string | null;
  aoiName: string | null;
  ruleType: RuleTypeId;
  params: Record<string, unknown>;
  severity: Severity;
  enabled: boolean;
  notifyInApp: boolean;
  notifyEmail: boolean;
  notifyRoles: OrgRole[];
  cooldownHours: number;
  escalateAfterHours: number | null;
  escalateToRoles: OrgRole[];
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const roles = z.array(z.enum(ORG_ROLES)).min(1).max(ORG_ROLES.length);

const ruleInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(""),
  aoiId: uuidSchema.nullable().default(null),
  ruleType: z.string().min(1).max(64),
  params: z.record(z.string(), z.unknown()).default({}),
  severity: z.enum(SEVERITIES),
  enabled: z.boolean().default(true),
  notifyInApp: z.boolean().default(true),
  notifyEmail: z.boolean().default(false),
  notifyRoles: roles.default(["org_admin", "analyst"]),
  cooldownHours: z.number().int().min(0).max(8760).default(24),
  escalateAfterHours: z.number().int().min(1).max(8760).nullable().default(null),
  escalateToRoles: roles.default(["org_admin"]),
});

export type AlertRuleInput = z.input<typeof ruleInputSchema>;
export type AlertRulePatch = Partial<AlertRuleInput>;

type RuleRow = {
  id: string;
  name: string;
  description: string;
  aoi_id: string | null;
  aoi_name: string | null;
  rule_type: RuleTypeId;
  params: Record<string, unknown>;
  severity: Severity;
  enabled: boolean;
  notify_in_app: boolean;
  notify_email: boolean;
  notify_roles: OrgRole[];
  cooldown_hours: number;
  escalate_after_hours: number | null;
  escalate_to_roles: OrgRole[];
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

function toRule(r: RuleRow): AlertRule {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    aoiId: r.aoi_id,
    aoiName: r.aoi_name,
    ruleType: r.rule_type,
    params: r.params,
    severity: r.severity,
    enabled: r.enabled,
    notifyInApp: r.notify_in_app,
    notifyEmail: r.notify_email,
    notifyRoles: r.notify_roles,
    cooldownHours: r.cooldown_hours,
    escalateAfterHours: r.escalate_after_hours,
    escalateToRoles: r.escalate_to_roles,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function invalid(err: z.ZodError): DomainError {
  const fields: Record<string, string> = {};
  for (const i of err.issues) fields[i.path.join(".") || "input"] = i.message;
  return new DomainError("invalid_rule", "The alert rule is invalid.", 422, fields);
}

function userId(access: OrgAccess): string | null {
  return access.principal.type === "user" ? access.principal.userId : null;
}

const SELECT = (tx: Tx) => tx`
  select r.id, r.name, r.description, r.aoi_id, a.name as aoi_name, r.rule_type, r.params, r.severity, r.enabled,
         r.notify_in_app, r.notify_email, r.notify_roles::text[] as notify_roles, r.cooldown_hours, r.escalate_after_hours,
         r.escalate_to_roles::text[] as escalate_to_roles, r.created_by, r.created_at, r.updated_at
    from alert_rules r left join aois a on a.id = r.aoi_id`;

/** Validate the full rule (type applicability, params, AOI ownership and visibility). */
async function normalize(tx: Tx, access: OrgAccess, input: z.output<typeof ruleInputSchema>) {
  if (!isRuleType(input.ruleType)) {
    throw new DomainError("invalid_rule_type", `Unknown rule type "${input.ruleType}".`, 422, { ruleType: "Unknown rule type." });
  }
  const def = RULE_TYPES[input.ruleType];
  if (!(def.orgKinds as readonly string[]).includes(access.org.kind)) {
    throw new DomainError("rule_not_applicable", `"${def.label}" rules are not available for ${access.org.kind} organizations.`, 422, {
      ruleType: "Not available for this organization.",
    });
  }
  const params = parseRuleParams(input.ruleType, input.params) as Record<string, unknown>;
  const visible = await visibleAoiIds(tx, access);
  if (input.aoiId) {
    const [aoi] = await tx<{ id: string }[]>`select id from aois where id = ${input.aoiId} and org_id = ${access.org.id}`;
    if (!aoi || (visible && !visible.includes(aoi.id))) {
      throw new DomainError("invalid_aoi", "The selected area of interest does not exist in this organization.", 422, { aoiId: "Unknown area." });
    }
  } else if (visible) {
    throw new DomainError("aoi_required", "Your access is limited to specific areas, so a rule must target one of them.", 422, {
      aoiId: "Select an area.",
    });
  }
  return { ...input, ruleType: input.ruleType, params };
}

async function findRule(tx: Tx, access: OrgAccess, ruleId: string, forUpdate = false): Promise<RuleRow> {
  if (!uuidSchema.safeParse(ruleId).success) throw notFoundError("Alert rule");
  const [row] = await tx<RuleRow[]>`${SELECT(tx)} where r.id = ${ruleId} and r.org_id = ${access.org.id} ${forUpdate ? tx`for update of r` : tx``}`;
  if (!row) throw notFoundError("Alert rule");
  const visible = await visibleAoiIds(tx, access);
  if (visible && (!row.aoi_id || !visible.includes(row.aoi_id))) throw notFoundError("Alert rule");
  return row;
}

export async function listAlertRules(access: OrgAccess, opts: { aoiId?: string; includeDisabled?: boolean } = {}): Promise<AlertRule[]> {
  access.assert("alerts.read");
  if (opts.aoiId && !uuidSchema.safeParse(opts.aoiId).success) return [];
  return access.tx(async (tx) => {
    const visible = await visibleAoiIds(tx, access);
    const rows = await tx<RuleRow[]>`
      ${SELECT(tx)}
       where r.org_id = ${access.org.id}
         ${visible ? tx`and r.aoi_id = any(${visible}::uuid[])` : tx``}
         ${opts.aoiId ? tx`and (r.aoi_id = ${opts.aoiId} or r.aoi_id is null)` : tx``}
         ${opts.includeDisabled === false ? tx`and r.enabled` : tx``}
       order by r.created_at, r.id`;
    return rows.map(toRule);
  });
}

export async function getAlertRule(access: OrgAccess, ruleId: string): Promise<AlertRule> {
  access.assert("alerts.read");
  return access.tx(async (tx) => toRule(await findRule(tx, access, ruleId)));
}

export async function createAlertRule(access: OrgAccess, input: AlertRuleInput): Promise<AlertRule> {
  access.assert("alert_rules.manage");
  const parsed = ruleInputSchema.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error);
  return access.tx(async (tx) => {
    const r = await normalize(tx, access, parsed.data);
    const [row] = await tx<{ id: string }[]>`
      insert into alert_rules (org_id, name, description, aoi_id, rule_type, params, severity, enabled, notify_in_app, notify_email,
                               notify_roles, cooldown_hours, escalate_after_hours, escalate_to_roles, created_by)
      values (${access.org.id}, ${r.name}, ${r.description}, ${r.aoiId}, ${r.ruleType}, ${jsonb(r.params)}::jsonb, ${r.severity},
              ${r.enabled}, ${r.notifyInApp}, ${r.notifyEmail}, ${r.notifyRoles}::org_role[], ${r.cooldownHours},
              ${r.escalateAfterHours}, ${r.escalateToRoles}::org_role[], ${userId(access)})
      returning id`;
    await recordAudit(tx, {
      orgId: access.org.id,
      actor: access.auditActor(),
      action: "alert_rule.create",
      targetType: "alert_rule",
      targetId: row!.id,
      metadata: { name: r.name, rule_type: r.ruleType, aoi_id: r.aoiId, params: r.params, severity: r.severity },
      ip: access.meta.ip,
      userAgent: access.meta.userAgent,
    });
    return toRule(await findRule(tx, access, row!.id));
  });
}

export async function updateAlertRule(access: OrgAccess, ruleId: string, patch: AlertRulePatch): Promise<AlertRule> {
  access.assert("alert_rules.manage");
  return access.tx(async (tx) => {
    const cur = await findRule(tx, access, ruleId, true);
    const merged = ruleInputSchema.safeParse({
      name: cur.name,
      description: cur.description,
      aoiId: cur.aoi_id,
      ruleType: cur.rule_type,
      params: cur.params,
      severity: cur.severity,
      enabled: cur.enabled,
      notifyInApp: cur.notify_in_app,
      notifyEmail: cur.notify_email,
      notifyRoles: cur.notify_roles,
      cooldownHours: cur.cooldown_hours,
      escalateAfterHours: cur.escalate_after_hours,
      escalateToRoles: cur.escalate_to_roles,
      ...Object.fromEntries(Object.entries(patch ?? {}).filter(([, v]) => v !== undefined)),
    });
    if (!merged.success) throw invalid(merged.error);
    const r = await normalize(tx, access, merged.data);
    await tx`
      update alert_rules set
        name = ${r.name}, description = ${r.description}, aoi_id = ${r.aoiId}, rule_type = ${r.ruleType},
        params = ${jsonb(r.params)}::jsonb, severity = ${r.severity}, enabled = ${r.enabled}, notify_in_app = ${r.notifyInApp},
        notify_email = ${r.notifyEmail}, notify_roles = ${r.notifyRoles}::org_role[], cooldown_hours = ${r.cooldownHours},
        escalate_after_hours = ${r.escalateAfterHours}, escalate_to_roles = ${r.escalateToRoles}::org_role[]
      where id = ${cur.id} and org_id = ${access.org.id}`;
    await recordAudit(tx, {
      orgId: access.org.id,
      actor: access.auditActor(),
      action: "alert_rule.update",
      targetType: "alert_rule",
      targetId: cur.id,
      metadata: { changed: Object.keys(patch ?? {}), rule_type: r.ruleType, params: r.params },
      ip: access.meta.ip,
      userAgent: access.meta.userAgent,
    });
    return toRule(await findRule(tx, access, cur.id));
  });
}

export async function setAlertRuleEnabled(access: OrgAccess, ruleId: string, enabled: boolean): Promise<AlertRule> {
  access.assert("alert_rules.manage");
  return access.tx(async (tx) => {
    const cur = await findRule(tx, access, ruleId, true);
    if (cur.enabled !== enabled) {
      await tx`update alert_rules set enabled = ${enabled} where id = ${cur.id} and org_id = ${access.org.id}`;
      await recordAudit(tx, {
        orgId: access.org.id,
        actor: access.auditActor(),
        action: enabled ? "alert_rule.enable" : "alert_rule.disable",
        targetType: "alert_rule",
        targetId: cur.id,
        ip: access.meta.ip,
        userAgent: access.meta.userAgent,
      });
    }
    return toRule({ ...cur, enabled });
  });
}

export const disableAlertRule = (access: OrgAccess, ruleId: string) => setAlertRuleEnabled(access, ruleId, false);

/** Delete a rule. Its alerts are kept (alerts.rule_id becomes null) so history is preserved. */
export async function deleteAlertRule(access: OrgAccess, ruleId: string): Promise<void> {
  access.assert("alert_rules.manage");
  await access.tx(async (tx) => {
    const cur = await findRule(tx, access, ruleId, true);
    await tx`delete from alert_rules where id = ${cur.id} and org_id = ${access.org.id}`;
    await recordAudit(tx, {
      orgId: access.org.id,
      actor: access.auditActor(),
      action: "alert_rule.delete",
      targetType: "alert_rule",
      targetId: cur.id,
      metadata: { name: cur.name, rule_type: cur.rule_type, aoi_id: cur.aoi_id },
      ip: access.meta.ip,
      userAgent: access.meta.userAgent,
    });
  });
}
