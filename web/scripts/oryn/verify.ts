/**
 * Live verification of a deployment's integrations — one minimal, real call
 * each, run deliberately by an operator. Prints what was checked and exits
 * non-zero on failure. Never prints secret values.
 *
 *   npm run oryn:verify -- config                 production preflight (environment only)
 *   npm run oryn:verify -- database               app role privileges, RLS coverage, migrations
 *   npm run oryn:verify -- storage                write/read/delete an object; bucket refuses anonymous reads
 *   npm run oryn:verify -- providers              health probe of every enabled provider
 *   npm run oryn:verify -- gdelt                  one GDELT article search (honours the shared cooldown)
 *   npm run oryn:verify -- nasa-hls               HLS search + authenticated read of one file header
 *   npm run oryn:verify -- email --to ops@example.org   sends ONE test message to that address
 *   npm run oryn:verify -- ai-summaries           one tiny request (synthetic text, no tenant data)
 *   npm run oryn:verify -- usgs-earthquakes       fetch and validate the USGS M2.5+ 30-day feed
 *   npm run oryn:verify -- nifc-wildfire-perimeters   fetch and validate current WFIGS perimeters
 *   npm run oryn:verify -- celestrak              fetch CelesTrak elements once and propagate every imaging satellite
 *   npm run oryn:verify -- caltrans-cctv          download and validate the 12 Caltrans camera lists (plays no video)
 *
 * Gated integrations (email, gdelt, nasa-hls, ai-summaries, and the public
 * event layers) stay off in
 * production until they pass here AND are added to ORYN_VERIFIED_INTEGRATIONS.
 */
import { loadEnvConfig } from "@next/env";
import { postgresTlsOptions } from "@/server/db/tls";

const TARBORO: [number, number] = [-77.535, 35.896];

async function main() {
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
  const target = process.argv[2];
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const ok = (msg: string) => console.log(`  ✓ ${msg}`);
  const fail = (msg: string) => {
    console.log(`  ✗ ${msg}`);
    process.exitCode = 1;
  };
  console.log(`Verifying ${target ?? "(nothing)"}${process.env.NODE_ENV === "production" ? " [production]" : ""}`);

  const { closeDb } = await import("@/server/db/client");
  try {
    switch (target) {
      case "config": {
        const { checkConfiguration } = await import("@/server/config/preflight");
        for (const role of ["web", "worker", "migrate"] as const) {
          const issues = checkConfiguration(role);
          if (!issues.length) ok(`${role}: no findings`);
          for (const i of issues) (i.level === "error" ? fail : (m: string) => console.log(`  ! ${m}`))(`${role}: [${i.code}] ${i.message}`);
        }
        break;
      }

      case "database": {
        const { default: postgres } = await import("postgres");
        const { checkDatabase } = await import("@/server/config/preflight");
        const url = process.env.DATABASE_URL;
        if (!url) return fail("DATABASE_URL is not set.");
        const sql = postgres(url, { ...postgresTlsOptions(url), max: 1, onnotice: () => {} });
        try {
          const issues = await checkDatabase(sql, "web");
          if (!issues.length) ok("application role cannot bypass RLS, every tenant table has RLS, migrations match this release");
          for (const i of issues) (i.level === "error" ? fail : (m: string) => console.log(`  ! ${m}`))(`[${i.code}] ${i.message}`);
        } finally {
          await sql.end({ timeout: 5 });
        }
        break;
      }

      case "storage": {
        const { env } = await import("@/server/config/env");
        const { probeStorage, storage, s3BucketUrl, s3ObjectUrl } = await import("@/server/storage");
        const driver = env.storageDriver();
        ok(`driver: ${driver}`);
        (await probeStorage(storage(), 0)) ? ok("write, read back (byte-identical), and delete") : fail("object read back did not match what was written");
        if (driver === "s3") {
          const cfg = env.s3();
          const key = `health/anonymous-probe-${process.pid}`;
          await storage().put(key, Buffer.from("private?"), "text/plain");
          try {
            const res = await fetch(s3ObjectUrl(s3BucketUrl(cfg), key));
            await res.body?.cancel().catch(() => {});
            res.status === 401 || res.status === 403 ? ok(`anonymous read refused (${res.status}) — bucket is private`) : fail(`anonymous read returned ${res.status}: the bucket or object is publicly readable`);
          } finally {
            await storage().delete(key);
          }
          ok(`server-side encryption requested: ${cfg.sse}`);
        }
        break;
      }

      case "providers": {
        const { checkProviderHealth, PROVIDERS, providerAvailability } = await import("@/server/providers/registry");
        for (const p of PROVIDERS) {
          const av = providerAvailability(p.id);
          if (av.state !== "available") {
            console.log(`  - ${p.id}: ${av.state} (${av.reason})`);
            continue;
          }
          if (p.id === "gdelt") {
            console.log("  - gdelt: skipped here (use `oryn:verify -- gdelt`, which honours its rate limit)");
            continue;
          }
          const h = await checkProviderHealth(p.id);
          h.ok ? ok(`${p.id}: ${h.latencyMs} ms`) : fail(`${p.id}: ${h.message ?? "probe failed"}`);
        }
        break;
      }

      case "gdelt": {
        const { searchArticles, GDELT_MIN_INTERVAL_MS } = await import("@/server/providers/news/gdelt");
        const slots = await import("@/server/providers/request-slots");
        const cooldown = await slots.providerCooldownRemaining("gdelt");
        if (cooldown.ms > 0) return fail(`GDELT is cooling down after a rate limit (${Math.ceil(cooldown.ms / 1000)} s left); try again later.`);
        try {
          const articles = await searchArticles({
            terms: ["weather"],
            start: new Date(Date.now() - 86_400_000),
            maxRecords: 5,
            gate: { enabled: true },
            acquireSlot: (signal) => slots.acquireProviderSlot("gdelt", GDELT_MIN_INTERVAL_MS, signal),
            onRateLimited: (ms, reason) => slots.startProviderCooldown("gdelt", ms, reason),
          });
          ok(`article search returned ${articles.length} articles`);
        } catch (err) {
          fail(`GDELT: ${(err as Error).message}`);
        }
        break;
      }

      case "nasa-hls": {
        const { env } = await import("@/server/config/env");
        const { createNasaCmrProvider } = await import("@/server/providers/imagery/nasa-cmr");
        const { httpRequest } = await import("@/server/providers/http");
        if (!env.earthdataToken()) return fail("EARTHDATA_TOKEN is not set.");
        const provider = createNasaCmrProvider({ token: env.earthdataToken() });
        const [w, s] = TARBORO;
        const items = await provider.search({
          productId: "nasa-cmr:hls",
          intersects: { type: "Polygon", coordinates: [[[w, s], [w + 0.01, s], [w + 0.01, s + 0.01], [w, s + 0.01], [w, s]]] },
          start: new Date(Date.now() - 45 * 86_400_000),
          end: new Date(),
          limit: 1,
        });
        if (!items.length) return fail("no HLS scenes found near Tarboro in the last 45 days; try again later");
        ok(`catalog search: ${items[0]!.externalId}`);
        const access = await provider.resolveAccess(items[0]!, "red");
        const res = await httpRequest(access.url, { providerId: "nasa-cmr", headers: { ...access.headers, range: "bytes=0-15", accept: "*/*" }, maxBytes: 1 << 20 });
        const magic = Buffer.from(res.body.slice(0, 4)).toString("hex");
        ["49492a00", "4d4d002a", "49492b00", "4d4d002b"].includes(magic) ? ok("authenticated read of a GeoTIFF header") : fail(`unexpected file header ${magic}`);
        break;
      }

      case "email": {
        const to = arg("to");
        if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return fail("pass --to <an address you control>; exactly one test message is sent there.");
        const { env } = await import("@/server/config/env");
        const { resendSender } = await import("@/server/notifications/email");
        const key = env.resendApiKey();
        const from = env.emailFrom();
        if (!key || !from) return fail("RESEND_API_KEY and ORYN_EMAIL_FROM must be set.");
        const r = await resendSender(key)({
          from,
          to,
          subject: "ORYN email verification",
          text: "This is a one-time test message sent by an ORYN operator with `npm run oryn:verify -- email`. No action is needed.",
          idempotencyKey: `oryn-verify-${Date.now()}`,
        });
        r.ok ? ok(`accepted by the email provider (id ${r.providerId ?? "n/a"}) — confirm it arrived at ${to} before marking email verified`) : fail(`email provider refused: ${r.error}`);
        break;
      }

      case "ai-summaries": {
        const { env } = await import("@/server/config/env");
        const key = env.anthropicApiKey();
        if (!key) return fail("ANTHROPIC_API_KEY is not set.");
        const { default: Anthropic } = await import("@anthropic-ai/sdk");
        const client = new Anthropic({ apiKey: key, timeout: 30_000, maxRetries: 1 });
        const msg = await client.messages.create({
          model: env.aiModel(),
          max_tokens: 16,
          messages: [{ role: "user", content: "Reply with the single word OK." }],
        });
        const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
        text ? ok(`model ${env.aiModel()} answered (${msg.stop_reason}); credentials and model access work`) : fail("empty response");
        console.log("  i This checks access with synthetic text only; report summaries also validate citations and fall back to the template.");
        break;
      }

      case "usgs-earthquakes":
      case "nifc-wildfire-perimeters": {
        const { publicEvents } = await import("@/server/public-events/service");
        // The gate is what this command verifies, so bypass it for this one call.
        const r = await publicEvents(target, { bbox: [-180, -90, 180, 90], days: 30 }, { production: false });
        if (!r || r.feed.state === "unavailable") return fail(r?.feed.message ?? "unknown layer");
        ok(`${r.layer.name}: ${r.total} records validated (state ${r.feed.state}${r.feed.generatedAt ? `, generated ${r.feed.generatedAt}` : ""})`);
        console.log(`  i Then add "${target}" to ORYN_VERIFIED_INTEGRATIONS for the web service.`);
        break;
      }

      case "celestrak": {
        const { satelliteTracks } = await import("@/server/intel/satellites");
        // One CelesTrak download (two small queries); the gate is what this verifies.
        const r = await satelliteTracks(new Date(), { production: false, halfWindowMinutes: 1 });
        if (r.feed.state === "unavailable") return fail(r.feed.message ?? "unavailable");
        const ok_ = r.satellites.filter((s) => s.track);
        ok(`${ok_.length}/${r.satellites.length} imaging satellites propagated (${ok_.map((s) => `${s.name} ${s.track!.elementsAgeHours} h`).join(", ")})`);
        if (r.feed.message) console.log(`  ! ${r.feed.message}`);
        console.log('  i Then add "celestrak" to ORYN_VERIFIED_INTEGRATIONS for the web service.');
        break;
      }

      case "caltrans-cctv": {
        const { cameras } = await import("@/server/intel/cameras");
        // Downloads the 12 district lists once (about 10 MB) and validates them; plays no video.
        const r = await cameras([-125, 32, -114, 42.1], { production: false });
        if (r.feed.state === "unavailable") return fail(r.feed.message ?? "unavailable");
        const withVideo = r.cameras.filter((c) => c.video).length;
        ok(`${r.total} in-service cameras listed (${withVideo} with live HLS video in the first ${r.cameras.length}); feed ${r.feed.state}`);
        if (r.feed.message) console.log(`  ! ${r.feed.message}`);
        console.log('  i Then add "caltrans-cctv" to ORYN_VERIFIED_INTEGRATIONS for the web service.');
        break;
      }

      default:
        fail("Usage: npm run oryn:verify -- config|database|storage|providers|gdelt|nasa-hls|email --to <addr>|ai-summaries|usgs-earthquakes|nifc-wildfire-perimeters|celestrak|caltrans-cctv");
    }
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
