/**
 * Development workspaces. Explicitly opt-in; refuses to run in production.
 *
 *   ORYN_ALLOW_SYNTHETIC_SEED=true npm run db:seed            # both workspaces + dev users
 *   npm run db:seed -- --tarboro                                # only the Tarboro workspace
 *   npm run db:seed -- --sample-farm                            # only the synthetic farm
 *
 * Tarboro, NC: the organization record and its users are development
 * fixtures, but the boundary is the real, public U.S. Census TIGERweb
 * boundary (GEOID 3766700), imported with full provenance. All imagery,
 * weather, warnings, and news gathered for it are real public data.
 *
 * Sample farm: a SYNTHETIC agricultural organization. Its field boundaries
 * are placeholders placed on land that ESA WorldCover 2021 classifies as
 * cropland near Tarboro (checked with the land-cover analyzer when this seed
 * was written) — they are not anyone's real fields, and the organization,
 * boundaries, and UI are labelled synthetic everywhere. Measurements over
 * them are real.
 *
 * Users get the password in ORYN_DEV_SEED_PASSWORD, or a random one printed
 * once. Nothing is emailed.
 */
import { randomBytes } from "node:crypto";
import { loadEnvConfig } from "@next/env";

type Box = [number, number, number, number]; // w, s, e, n
const poly = ([w, s, e, n]: Box) => ({ type: "Polygon" as const, coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] as [number, number][][] });

async function main() {
  loadEnvConfig(process.cwd());
  // Synthetic development data never goes into a production database; there is no override.
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed development data with NODE_ENV=production.");
  }
  if (process.env.ORYN_ALLOW_SYNTHETIC_SEED !== "true") {
    throw new Error("Set ORYN_ALLOW_SYNTHETIC_SEED=true to create development workspaces.");
  }
  const only = (flag: string) => process.argv.includes(flag);
  const doTarboro = only("--tarboro") || !only("--sample-farm");
  const doFarm = only("--sample-farm") || !only("--tarboro");

  const [{ default: postgres }, accounts, authOpts, access, aois, boundary, rules, models, db] = await Promise.all([
    import("postgres"),
    import("@/server/accounts/service"),
    import("@/server/auth/options"),
    import("@/server/authz/access"),
    import("@/server/aois/service"),
    import("@/server/aois/boundary-import"),
    import("@/server/alerts/rule-service"),
    import("@/server/analytics/registry"),
    import("@/server/db/client"),
  ]);
  const owner = postgres(process.env.DATABASE_OWNER_URL!, { max: 1, onnotice: () => {} });
  const password = process.env.ORYN_DEV_SEED_PASSWORD ?? randomBytes(12).toString("base64url");
  const meta = { ip: null, userAgent: "seed" };
  const created: string[] = [];

  await db.withSystem("seed.models", (tx) => models.registerAnalytics(tx));

  async function user(email: string, name: string) {
    const [u] = await owner<{ id: string }[]>`select id from auth_user where lower(email) = ${email}`;
    if (u) return u.id;
    const n = await accounts.createCredentialUser({ email, name, password, emailVerified: true }, "dev_seed");
    created.push(email);
    return n.id;
  }

  async function org(slug: string, name: string, kind: string, synthetic: boolean, settings: Record<string, unknown>) {
    const [o] = await owner<{ id: string }[]>`select id from organizations where slug = ${slug}`;
    if (o) return { id: o.id, fresh: false };
    const [n] = await owner<{ id: string }[]>`
      insert into organizations (slug, name, kind, is_synthetic, settings) values (${slug}, ${name}, ${kind}, ${synthetic}, ${owner.json(settings as never)})
      returning id`;
    await owner`insert into audit_events (org_id, actor_type, actor_label, action, target_type, target_id, metadata)
                values (${n!.id}, 'system', 'dev-seed', 'platform.org_create', 'organization', ${n!.id}, ${owner.json({ synthetic } as never)})`;
    return { id: n!.id, fresh: true };
  }

  async function member(orgId: string, userId: string, role: string) {
    await owner`insert into memberships (org_id, user_id, role, created_by) values (${orgId}, ${userId}, ${role}, 'dev-seed') on conflict (org_id, user_id) do nothing`;
  }

  const analyst = await user("analyst@oryn.local", "Dev Analyst");
  const viewer = await user("viewer@oryn.local", "Dev Viewer");
  const auditor = await user("auditor@oryn.local", "Dev Auditor");

  if (doTarboro) {
    const admin = await user("tarboro-admin@oryn.local", "Dev Tarboro Administrator");
    const operator = await user("field@oryn.local", "Dev Field Operator");
    const o = await org("tarboro-nc", "Town of Tarboro, North Carolina", "municipal", false, { timezone: "America/New_York", exportsEnabled: true });
    for (const [u, r] of [[admin, "org_admin"], [analyst, "analyst"], [viewer, "viewer"], [auditor, "auditor"], [operator, "field_operator"]] as const) await member(o.id, u, r);
    if (o.fresh) {
      const a = await access.resolveUserOrgAccess({ id: admin, label: "tarboro-admin@oryn.local", isPlatformAdmin: false }, "tarboro-nc", meta);
      const boundaryAoi = await boundary.importCensusBoundary(a, { geoid: "3766700", level: "place", name: "Tarboro town limits", kind: "municipal_boundary", newsTerms: ["Tarboro"] });
      await aois.updateAoi(a, boundaryAoi.id, {
        dataSources: ["earth-search:sentinel-2-l2a", "planetary-computer:sentinel-1-rtc", "planetary-computer:esa-worldcover", "planetary-computer:io-lulc-annual-v02", "nws", "gdelt"],
        enabledAnalytics: ["ndvi", "ndwi", "s1-water", "landcover-composition", "ndvi-change", "water-change"],
        monitoringIntervalHours: 24,
      });
      const base = { notifyRoles: ["org_admin", "analyst"] as ("org_admin" | "analyst")[] };
      await rules.createAlertRule(a, { ...base, name: "Candidate land change", ruleType: "detection_created", severity: "moderate", params: { types: ["vegetation_decline"], min_area_m2: 2000, min_evidence_grade: "moderate" } });
      await rules.createAlertRule(a, { ...base, name: "Possible new surface water", ruleType: "detection_created", severity: "high", params: { types: ["new_water_candidate"], min_area_m2: 5000, min_evidence_grade: "moderate" } });
      await rules.createAlertRule(a, { ...base, name: "Official NWS warning", ruleType: "nws_warning", severity: "high", cooldownHours: 6, params: { min_severity: "Moderate" } });
      await rules.createAlertRule(a, { ...base, name: "Heavy rain (3 days)", ruleType: "precipitation_total_above", severity: "moderate", params: { window_days: 3, threshold_mm: 75, kinds: ["observation", "model_estimate"] } });
      await rules.createAlertRule(a, { ...base, name: "No usable imagery for 30 days", ruleType: "stale_observations", severity: "low", cooldownHours: 168, params: { max_age_days: 30, kinds: [] } });
    }
    console.log("Tarboro workspace: /app/tarboro-nc");
  }

  if (doFarm) {
    const admin = await user("farm-admin@oryn.local", "Dev Farm Administrator");
    const o = await org("sample-farms", "Sample Farms (synthetic)", "agriculture", true, { timezone: "America/New_York", exportsEnabled: true });
    for (const [u, r] of [[admin, "org_admin"], [analyst, "analyst"], [viewer, "viewer"], [auditor, "auditor"]] as const) await member(o.id, u, r);
    if (o.fresh) {
      const a = await access.resolveUserOrgAccess({ id: admin, label: "farm-admin@oryn.local", isPlatformAdmin: false }, "sample-farms", meta);
      const note = "Synthetic development boundary placed on land classified as cropland in ESA WorldCover 2021. Not a real customer field.";
      const src = { method: "synthetic" as const, note, retrieved_at: new Date().toISOString() };
      const farm = await aois.createAoi(a, { name: "East tract (synthetic)", kind: "farm", geometry: poly([-77.4505, 35.8395, -77.4450, 35.8641]), monitoringEnabled: false }, { boundarySource: src, isSynthetic: true });
      const fields: [string, Box, string][] = [
        ["Field A (synthetic)", [-77.45, 35.84, -77.4455, 35.8436], "cotton"],
        ["Field B (synthetic)", [-77.45, 35.86, -77.4455, 35.8636], "soybeans"],
        ["Field C (synthetic)", [-77.47, 35.92, -77.4655, 35.9236], "peanuts"],
      ];
      for (const [name, box, crop] of fields) {
        await aois.createAoi(a, { name, kind: "field", geometry: poly(box), parentId: box[1] < 35.9 ? farm.id : null, metadata: { crop, season: "2026" } }, { boundarySource: src, isSynthetic: true });
      }
      const base = { notifyRoles: ["org_admin", "analyst"] as ("org_admin" | "analyst")[] };
      await rules.createAlertRule(a, { ...base, name: "NDVI drop vs. field baseline", ruleType: "ndvi_drop_vs_baseline", severity: "moderate", params: { min_drop: 0.12, min_baseline_n: 3, baseline_days: 90 } });
      await rules.createAlertRule(a, { ...base, name: "Vegetation decline detected", ruleType: "detection_created", severity: "moderate", params: { types: ["vegetation_decline"], min_area_m2: 2000, min_evidence_grade: "moderate" } });
      await rules.createAlertRule(a, { ...base, name: "Dry spell (10 days)", ruleType: "dry_spell", severity: "low", cooldownHours: 72, params: { days: 10, max_daily_mm: 1 } });
      await rules.createAlertRule(a, { ...base, name: "Heat stress forecast", ruleType: "heat_stress", severity: "moderate", params: { threshold_c: 35, consecutive_days: 2, kind: "forecast" } });
      await rules.createAlertRule(a, { ...base, name: "Official NWS warning", ruleType: "nws_warning", severity: "high", params: { min_severity: "Severe" } });
    }
    console.log("Sample farm workspace: /app/sample-farms (synthetic)");
  }

  if (created.length) {
    console.log(`Created users: ${created.join(", ")}`);
    if (!process.env.ORYN_DEV_SEED_PASSWORD) console.log(`Password for new users (shown once): ${password}`);
  }
  await owner.end({ timeout: 5 });
  await authOpts.closeAuthPool();
  await db.closeDb();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
