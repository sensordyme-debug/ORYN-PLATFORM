/**
 * End-to-end test fixtures (synthetic). Recreates isolated organizations —
 * e2e-farm (agriculture), e2e-city (municipal), and e2e-trial (a trial
 * workspace) — plus test users, one AOI each, and one synthetic candidate
 * detection for review. Username accounts: e2e_trial (trial-only),
 * e2e_partner (administrator-issued password that must be changed), and
 * e2e_disabled (disabled).
 * Prints the ids as JSON for the Playwright suite. Refuses production.
 *
 *   npx tsx scripts/oryn/e2e-fixtures.ts
 */
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";

async function main() {
  loadEnvConfig(process.cwd());
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to create e2e fixtures in production.");
  const password = process.env.E2E_PASSWORD ?? "e2e-password-0123456789";
  const [{ default: postgres }, accounts, authOpts, models, db] = await Promise.all([
    import("postgres"),
    import("@/server/accounts/service"),
    import("@/server/auth/options"),
    import("@/server/analytics/registry"),
    import("@/server/db/client"),
  ]);
  const sql = postgres(process.env.DATABASE_OWNER_URL!, { max: 1, onnotice: () => {} });
  await db.withSystem("e2e.models", (tx) => models.registerAnalytics(tx));

  const user = async (email: string, name: string) => {
    const [u] = await sql<{ id: string }[]>`select id from auth_user where email = ${email}`;
    if (u) return u.id;
    return (await accounts.createCredentialUser({ email, name, password, emailVerified: true }, "e2e")).id;
  };

  // Organizations with audit history are never deleted; reset their data instead.
  const op = { type: "cli", label: "e2e-fixtures" } as const;
  await accounts.ensureTrialOrganization(op, { slug: "e2e-trial", name: "E2E Trial Workspace", kind: "agriculture" });
  const prior = await sql<{ id: string }[]>`select id from organizations where slug in ('e2e-farm', 'e2e-city', 'e2e-trial')`;
  for (const p of prior) {
    for (const t of ["alerts", "alert_rules", "notes", "exports", "reports", "uploads", "jobs", "aois", "invitations", "api_keys", "memberships"]) {
      await sql`delete from ${sql(t)} where org_id = ${p.id}`;
    }
  }
  // Accounts created through the admin UI by earlier runs.
  await sql`delete from auth_user where username like 'e2e\_ui\_%'`;
  const analyst = await user("e2e-analyst@oryn.local", "E2E Analyst");
  const platformAdmin = await user("e2e-admin@oryn.local", "E2E Platform Admin");
  await sql`insert into platform_admins (user_id, granted_by) values (${platformAdmin}, 'e2e-fixtures') on conflict do nothing`;
  const viewer = await user("e2e-viewer@oryn.local", "E2E Viewer");
  const cityAdmin = await user("e2e-city-admin@oryn.local", "E2E City Admin");
  await sql`delete from auth_rate_limit`;

  const org = async (slug: string, name: string, kind: string) => {
    const [o] = await sql<{ id: string }[]>`insert into organizations (slug, name, kind, is_synthetic, settings, onboarding_completed_at)
      values (${slug}, ${name}, ${kind}, true, ${sql.json({ timezone: "America/New_York", exportsEnabled: true })}, now())
      on conflict (slug) do update set settings = excluded.settings, archived_at = null returning id`;
    return o!.id;
  };
  const farm = await org("e2e-farm", "E2E Farm (synthetic)", "agriculture");
  const city = await org("e2e-city", "E2E City (synthetic)", "municipal");
  for (const [o, u, r] of [[farm, analyst, "analyst"], [farm, viewer, "viewer"], [city, analyst, "analyst"], [city, cityAdmin, "org_admin"]] as const) {
    await sql`insert into memberships (org_id, user_id, role, created_by) values (${o}, ${u}, ${r}, 'e2e')`;
  }

  const square = (lon: number, lat: number, d: number) =>
    JSON.stringify({ type: "Polygon", coordinates: [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]] });
  const aoi = async (orgId: string, name: string, kind: string, lon: number, lat: number) => {
    const [a] = await sql<{ id: string }[]>`
      insert into aois (org_id, name, kind, geom, boundary_source, is_synthetic, monitoring_enabled, data_sources, enabled_analytics)
      values (${orgId}, ${name}, ${kind}, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${square(lon, lat, 0.01)}), 4326)),
              ${sql.json({ method: "synthetic", note: "End-to-end test fixture" })}, true, false, '{earth-search:sentinel-2-l2a}', '{ndvi,ndvi-change}')
      returning id`;
    return a!.id;
  };
  const farmAoi = await aoi(farm, "E2E North field", "field", -77.45, 35.84);
  const cityAoi = await aoi(city, "E2E Downtown", "region", -77.54, 35.89);
  const [trialOrg] = await sql<{ id: string }[]>`select id from organizations where slug = 'e2e-trial'`;
  const trialAoi = await aoi(trialOrg!.id, "E2E Trial field", "field", -77.46, 35.85);

  // Username accounts. Re-running resets their state: the suite changes the
  // partner's password and checks that the disabled account stays out.
  await accounts.createPartnerAccount(op, { username: "E2E_Trial", name: "E2E Trial", orgSlug: "e2e-trial", role: "viewer", trialOnly: true }, { password });
  await accounts.resetAccountPassword(op, "e2e_trial", { password, requireChange: true });
  await accounts.createPartnerAccount(op, { username: "E2E_Partner", name: "E2E Partner", orgSlug: "e2e-city", role: "viewer" }, { password });
  await accounts.resetAccountPassword(op, "e2e_partner", { password, requireChange: true });
  await accounts.createPartnerAccount(op, { username: "E2E_Disabled", name: "E2E Disabled", orgSlug: "e2e-city", role: "viewer" }, { password });
  await accounts.setAccountDisabled(op, "e2e_disabled", true, { reason: "e2e fixture" });

  // A synthetic candidate change with two synthetic observations as evidence.
  const obs: string[] = [];
  const assetIds: string[] = [];
  for (const [days, mean] of [[13, 0.7], [3, 0.4]] as const) {
    const [asset] = await sql<{ id: string }[]>`
      insert into source_assets (provider_id, collection, external_id, kind, platform, acquired_at, footprint, cloud_cover, gsd_m, epsg, grid_code, metadata_hash, license, attribution)
      values ('e2e', 'sentinel-2-l2a', ${"E2E_" + randomUUID()}, 'optical', 'synthetic', now() - make_interval(days => ${days}),
              ST_SetSRID(ST_GeomFromGeoJSON(${square(-77.6, 35.8, 0.2)}), 4326), 5, 10, 32618, 'MGRS-18STE', 'e2e', 'synthetic test fixture', 'Synthetic test fixture')
      returning id`;
    assetIds.push(asset!.id);
    const [run] = await sql<{ id: string }[]>`
      insert into processing_runs (org_id, aoi_id, model_id, model_version, status, input_asset_ids, software_version, finished_at)
      values (${city}, ${cityAoi}, 'ndvi', '1.0.0', 'succeeded', ${[asset!.id]}::uuid[], 'e2e', now()) returning id`;
    const [o] = await sql<{ id: string }[]>`
      insert into observations (org_id, aoi_id, run_id, asset_id, model_id, model_version, kind, result_class, observed_at, status, metrics, quality)
      values (${city}, ${cityAoi}, ${run!.id}, ${asset!.id}, 'ndvi', ${`1.0.0`}, 'ndvi', 'deterministic_calculation',
              now() - make_interval(days => ${days}), 'valid', ${sql.json({ mean })}, ${sql.json({ coverage_fraction: 1, masked_fraction: 0, flags: [], gsd_m: 10, scene_cloud_cover: 5 })})
      returning id`;
    obs.push(o!.id);
  }
  const [det] = await sql<{ id: string }[]>`
    insert into detections (org_id, aoi_id, type, result_class, title, geom, area_m2, baseline_observation_id, comparison_observation_id,
                            baseline_observed_at, comparison_observed_at, first_observed_at, last_observed_at, source_asset_ids,
                            model_id, model_version, metrics, thresholds, evidence_grade, evidence_reasons, dedupe_key)
    values (${city}, ${cityAoi}, 'vegetation_decline', 'candidate_change', 'E2E vegetation loss / possible land disturbance, 1.2 ha',
            ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${square(-77.537, 35.893, 0.001)}), 4326)), 12000, ${obs[0] ?? null}, ${obs[1] ?? null},
            now() - interval '13 days', now() - interval '3 days', now() - interval '13 days', now() - interval '3 days', ${assetIds}::uuid[],
            'ndvi-change', '1.0.0', ${sql.json({ mean_delta: -0.3, pixel_count: 120, area_m2: 12000, direction: "decrease", valid_overlap_fraction: 0.95, days_between: 10, same_grid: true })},
            ${sql.json({ ndvi_delta: 0.2 })}, 'strong', ${["Synthetic fixture for end-to-end tests."]}, ${"e2e-" + randomUUID()})
    returning id`;

  // A synthetic within-field low-vigour zone on the farm, found in one synthetic NDVI observation.
  const [zAsset] = await sql<{ id: string }[]>`
    insert into source_assets (provider_id, collection, external_id, kind, platform, acquired_at, footprint, cloud_cover, gsd_m, epsg, grid_code, metadata_hash, license, attribution)
    values ('e2e', 'sentinel-2-l2a', ${"E2E_" + randomUUID()}, 'optical', 'synthetic', now() - interval '4 days',
            ST_SetSRID(ST_GeomFromGeoJSON(${square(-77.6, 35.7, 0.3)}), 4326), 3, 10, 32618, 'MGRS-18STE', 'e2e', 'synthetic test fixture', 'Synthetic test fixture')
    returning id`;
  const [zRun] = await sql<{ id: string }[]>`
    insert into processing_runs (org_id, aoi_id, model_id, model_version, status, input_asset_ids, software_version, finished_at)
    values (${farm}, ${farmAoi}, 'ndvi', '1.0.0', 'succeeded', ${[zAsset!.id]}::uuid[], 'e2e', now()) returning id`;
  const [zObs] = await sql<{ id: string }[]>`
    insert into observations (org_id, aoi_id, run_id, asset_id, model_id, model_version, kind, result_class, observed_at, status, metrics, quality)
    values (${farm}, ${farmAoi}, ${zRun!.id}, ${zAsset!.id}, 'ndvi', '1.0.0', 'ndvi', 'deterministic_calculation', now() - interval '4 days', 'valid',
            ${sql.json({ mean: 0.8, median: 0.82, p10: 0.7, p90: 0.88, valid_fraction: 0.97 })}, ${sql.json({ coverage_fraction: 1, masked_fraction: 0.03, flags: [], gsd_m: 10, scene_cloud_cover: 3 })})
    returning id`;
  const [zone] = await sql<{ id: string }[]>`
    insert into detections (org_id, aoi_id, type, result_class, title, geom, area_m2, comparison_observation_id, comparison_observed_at,
                            first_observed_at, last_observed_at, source_asset_ids, model_id, model_version, metrics, thresholds,
                            evidence_grade, evidence_reasons, limitations, dedupe_key)
    values (${farm}, ${farmAoi}, 'low_vigor_zone', 'deterministic_calculation', 'E2E low-vigour zone #1: NDVI 0.55 vs field median 0.82, 0.6 ha',
            ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${square(-77.446, 35.844, 0.0008)}), 4326)), 6400, ${zObs!.id}, now() - interval '4 days',
            now() - interval '4 days', now() - interval '4 days', ${[zAsset!.id]}::uuid[], 'ndvi-zones', '1.0.0',
            ${sql.json({ rank: 1, pixel_count: 64, area_m2: 6400, mean_ndvi: 0.55, min_ndvi: 0.41, field_median: 0.82, deficit: 0.27, relative_deficit: 0.33, threshold: 0.7, score: 0.17, edge_masked_fraction: 0, boundary_edge_fraction: 0.1, share_of_valid_area: 0.02, persistence: { state: "unknown", reason: "No earlier usable image within 45 days to check persistence." } })},
            ${sql.json({ k: 1.5, min_deficit: 0.1, min_area_m2: 2000, threshold_ndvi: 0.7 })}, 'strong', ${["Synthetic fixture for end-to-end tests."]},
            ${["A low-vigour zone is NDVI that is low relative to the rest of the same area on the same date. It is not a diagnosis."]}, ${"e2e-" + randomUUID()})
    returning id`;

  await sql`delete from auth_rate_limit`;
  console.log(JSON.stringify({ password, farm, city, farmAoi, cityAoi, trialAoi, detection: det!.id, zone: zone!.id }));
  await sql.end();
  await authOpts.closeAuthPool();
  await db.closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
