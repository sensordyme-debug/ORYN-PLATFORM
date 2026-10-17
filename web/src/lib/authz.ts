/**
 * Role → permission matrix. Pure data, shared by the server (enforcement) and
 * the client (deciding which controls to render). The server is the only
 * place access is decided; the client copy only avoids showing controls that
 * would be refused.
 */

export const ORG_ROLES = ["org_admin", "analyst", "field_operator", "viewer", "auditor"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const ROLE_LABEL: Record<OrgRole, string> = {
  org_admin: "Organization administrator",
  analyst: "Analyst",
  field_operator: "Field operator",
  viewer: "Read-only viewer",
  auditor: "Auditor",
};

export const ROLE_DESCRIPTION: Record<OrgRole, string> = {
  org_admin: "Manages members, settings, data sources, and everything analysts can do.",
  analyst: "Creates and edits areas of interest, runs analyses, reviews detections, manages alert rules, and exports results.",
  field_operator: "Views assigned areas, records field notes, and acknowledges or resolves alerts.",
  viewer: "Views maps, results, alerts, and reports. Cannot change anything.",
  auditor: "Read-only access to all records plus the audit trail and processing history.",
};

export const PERMISSIONS = [
  "org.read",
  "org.manage",
  "members.read",
  "members.manage",
  "apikeys.manage",
  "aoi.read",
  "aoi.write",
  "imagery.search",
  "analysis.run",
  "results.read",
  "detections.review",
  "notes.write",
  "alerts.read",
  "alerts.respond",
  "alert_rules.manage",
  "reports.read",
  "reports.generate",
  "exports.create",
  "jobs.read",
  "jobs.manage",
  "providers.read",
  "layers.manage",
  "uploads.create",
  "audit.read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ: Permission[] = ["org.read", "aoi.read", "results.read", "alerts.read", "reports.read", "providers.read"];

export const ROLE_PERMISSIONS: Record<OrgRole, ReadonlySet<Permission>> = {
  org_admin: new Set<Permission>(PERMISSIONS),
  analyst: new Set<Permission>([
    ...READ,
    "members.read",
    "aoi.write",
    "imagery.search",
    "analysis.run",
    "detections.review",
    "notes.write",
    "alerts.respond",
    "alert_rules.manage",
    "reports.generate",
    "exports.create",
    "jobs.read",
    "jobs.manage",
    "layers.manage",
    "uploads.create",
  ]),
  field_operator: new Set<Permission>([...READ, "notes.write", "alerts.respond"]),
  viewer: new Set<Permission>(READ),
  auditor: new Set<Permission>([...READ, "members.read", "jobs.read", "audit.read"]),
};

export function roleCan(role: OrgRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/** API keys carry a subset of permissions; never more than read+write data scopes. */
export const API_KEY_SCOPES: Permission[] = [
  "aoi.read",
  "aoi.write",
  "results.read",
  "alerts.read",
  "reports.read",
  "imagery.search",
  "analysis.run",
  "exports.create",
  "jobs.read",
];
