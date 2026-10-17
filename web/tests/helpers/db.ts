/**
 * Fixtures for integration tests. Fixture setup uses the OWNER connection
 * (bypasses RLS) so tests can arrange data across tenants; the code under
 * test always runs through the application role, where RLS applies.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import type { OrgRole } from "@/lib/authz";
import { registerAnalytics } from "@/server/analytics/registry";
import { closeDb, withSystem } from "@/server/db/client";
import { testDatabaseUrls } from "./test-env";

let owner: postgres.Sql | null = null;

export function ownerSql(): postgres.Sql {
  if (!owner) owner = postgres(testDatabaseUrls().owner, { max: 2, onnotice: () => {} });
  return owner;
}

export async function closeTestDb() {
  await owner?.end({ timeout: 5 });
  owner = null;
  await closeDb();
}

const TABLES = [
  "notifications", "alert_events", "alerts", "alert_rules",
  "aoi_news_matches", "news_articles", "external_events", "weather_records",
  "reference_features", "reference_layers", "uploads", "exports", "reports",
  "saved_scenes", "notes", "detections", "observations", "processing_runs", "jobs",
  "aoi_assets", "source_assets", "provider_sync_runs", "provider_status", "provider_request_slots", "worker_heartbeats", "aoi_grants", "aois",
  "api_keys", "invitations", "memberships", "organizations", "platform_admins", "account_controls",
  "auth_session", "auth_account", "auth_verification", "auth_rate_limit", "auth_user",
];

/** Truncate every application table. audit_events is append-only, so it is truncated (TRUNCATE bypasses row triggers) as the owner. */
export async function resetDb() {
  const sql = ownerSql();
  await sql.unsafe(`truncate ${[...TABLES, "audit_events"].join(", ")} restart identity cascade`);
  await withSystem("test.register_models", (tx) => registerAnalytics(tx));
}

export async function createUser(email = `${randomUUID().slice(0, 8)}@example.test`, name = "Test User") {
  const id = randomUUID();
  await ownerSql()`insert into auth_user (id, name, email, "emailVerified") values (${id}, ${name}, ${email}, true)`;
  return { id, email, name };
}

export async function createOrg(slug: string, kind: "agriculture" | "municipal" | "enterprise" = "agriculture") {
  const [o] = await ownerSql()<{ id: string }[]>`
    insert into organizations (slug, name, kind) values (${slug}, ${"Org " + slug}, ${kind}) returning id`;
  return { id: o!.id, slug };
}

export async function addMember(orgId: string, userId: string, role: OrgRole, aoiRestricted = false) {
  const [m] = await ownerSql()<{ id: string }[]>`
    insert into memberships (org_id, user_id, role, aoi_restricted) values (${orgId}, ${userId}, ${role}, ${aoiRestricted}) returning id`;
  return m!.id;
}

export const SQUARE = (lon: number, lat: number, d = 0.01) => ({
  type: "Polygon" as const,
  coordinates: [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]] as [number, number][][],
});

export async function insertAoi(orgId: string, name = "Test AOI", geom = SQUARE(-77.6, 35.9)) {
  const [a] = await ownerSql()<{ id: string }[]>`
    insert into aois (org_id, name, kind, geom, boundary_source, enabled_analytics, data_sources)
    values (${orgId}, ${name}, 'field', ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geom)}), 4326)),
            '{"method":"test"}'::jsonb, '{ndvi}', '{earth-search:sentinel-2-l2a}')
    returning id`;
  return a!.id;
}

export const meta = { ip: "127.0.0.1", userAgent: "vitest" };
