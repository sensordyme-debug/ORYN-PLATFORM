# Operations

## Deployment topology

| Component | Requirement |
| --- | --- |
| Web app | Container image from `Dockerfile.web` (`node server.js`), or Node.js 20.9+ with `npm ci && npm run build && npm run start`. Stateless; scale horizontally. See [DEPLOYMENT.md](DEPLOYMENT.md). |
| Worker | Container image from `Dockerfile.worker` (`node dist/worker.mjs`), or `npm run worker`. One or more replicas — jobs are claimed with `FOR UPDATE SKIP LOCKED`, so replicas never run the same job. Scheduler enqueues are idempotent per time bucket. |
| Database | PostgreSQL 15+ with PostGIS 3.4+. Two roles: schema owner (migrations, admin CLI) and `oryn_app` (member of `oryn_app_role`, **no** superuser, **no** BYPASSRLS). |
| Object storage | S3-compatible bucket (`ORYN_STORAGE_DRIVER=s3`) for any multi-instance deployment. Objects are written with SSE (AES256). Block public access. |
| Email (optional) | Resend API key and a verified sender (`RESEND_API_KEY`, `ORYN_EMAIL_FROM`). |

### Without a long-running worker

Schedule `GET /api/cron/tick` every minute with `Authorization: Bearer $ORYN_CRON_SECRET` (e.g. Vercel Cron). Each call runs the scheduler and drains up to 25 jobs within ~4 minutes. Imagery processing is CPU- and network-heavy; a dedicated worker is recommended for production.

### Release procedure

The full procedure, rollback plan, and per-migration notes are in [DEPLOYMENT.md](DEPLOYMENT.md#release-procedure). In short:

1. Build the new images; snapshot the database.
2. `migrate.mjs --status`, then run the migration job with `DATABASE_OWNER_URL` (forward-only, advisory-locked, one transaction and a 15 s lock timeout per file, checksummed; editing an applied migration is refused; the app role is refused).
3. Deploy worker and web. Each refuses to start while migrations are pending. Workers finish in-flight jobs on SIGTERM (30 s grace); jobs interrupted harder are reclaimed after 120 s without a heartbeat and counted as a failed attempt.
4. If an analytic's behaviour changed, its version was bumped in `src/server/analytics/registry.ts`. Earlier results remain as history; to recompute recent comparisons use `npx tsx scripts/oryn/rerun-change-detection.ts <org-slug>`.

## Backup and recovery

ORYN does **not** perform backups itself. Configure them in the hosting platform:

* **Database:** enable automated backups with point-in-time recovery (managed PostgreSQL) or `pg_basebackup` + WAL archiving. Minimum: daily `pg_dump -Fc` of the database, encrypted, stored off-site, retained per your policy. The database holds all tenant data, the audit trail, sessions, and the job queue.
* **Object storage:** enable bucket versioning and replication. It holds rendered previews, derived grids, reports, exports, and normalized uploads. Derived rasters can be regenerated from source imagery by reprocessing; reports and uploads cannot.
* **Restore test:** restore into a staging database at least quarterly, run `npm run db:migrate` (should report nothing to apply), start the app, and sign in.
* **Recovery order:** database → object storage → web app → worker. After a restore, stale `running` jobs are reclaimed automatically; failed/dead jobs can be retried from the Processing page.

## Monitoring

* **Logs:** JSON lines on stdout/stderr (`t`, `level`, `msg`, fields). Credentials, bearer tokens, API keys, and signed-URL query strings are redacted. Ship to your log platform.
* **Readiness:** web `GET /api/health/ready` (database as the app role, migrations, storage write/read/delete; plus worker heartbeat age), worker `GET :8081/readyz`. Worker heartbeats: `select * from worker_heartbeats order by last_seen_at desc`.
* **Key events:** `preflight` (startup findings), `readiness.check_failed`, `worker.fatal`, `auth.sign_in_refused` (disabled account), `auth.signup_rejected`, `auth.disabled_session_revoked`, `job.failed` (with `next`: `queued` = will retry, `dead` = retries exhausted, `failed` = permanent), `worker.reclaimed_stale_jobs`, `provider request` (status, latency), `api_failed` / `action_failed` (with a reference id shown to the user), `config_error`.
* **Health:** provider status is recorded on every sync and by `provider.health_check` every 30 minutes (Data sources page; table `provider_status`). Queue state: Processing page, or `select status, type, count(*) from jobs group by 1, 2`.
* **Suggested alerts:** dead jobs > 0; queued jobs older than 1 hour; any provider `unavailable` for > 2 hours; error-rate spikes in `api_failed`.

No metrics endpoint or service-level objective is defined yet; do not assume one.

## Data retention

Per-organization settings (Settings → General): audit trail (min 90 days, default 365), news matches (180), export files (7), finished jobs (30); read notifications are purged after 90 days. The `retention.purge` job runs daily per organization and records counts in the audit trail. Observations, detections, alerts, and reports are kept until deleted with their area or organization. Organizations are archived, not deleted (an organization with audit history cannot be deleted).

## Administration

* Platform administrators: `npm run oryn:admin -- create|grant|revoke|list` (operator with owner credentials). There is no web bootstrap route.
* Organizations and their first administrator: `/app/admin` (platform administrators only; audited in the organization's trail).
* Partner and trial accounts: `/app/admin/accounts` or `npm run oryn:accounts` (below).
* Members, roles, AOI restrictions, invitations, API keys: organization Settings (organization administrators, within their organization).

## Accounts

There is no public registration. An account comes from one of: a platform administrator (web UI or CLI), an operator CLI, or an organization invitation link. Users sign in with a **username** and password; accounts created from an email invitation may also use their email address.

**Rules enforced by the server** (`src/server/accounts/service.ts`, `src/server/authz/access.ts`, `db/migrations/0006_partner_accounts.sql`):

| State | Effect |
| --- | --- |
| Must change password | Set whenever an administrator issues a password (new account or reset). The account can sign in but no **non-trial** organization opens — pages redirect to `/app/account`, the API answers `403 password_change_required` — until its owner replaces the password there. |
| Trial-only | The account can be a member of, and open, **trial organizations only** (`organizations.is_trial`, which the database requires to be synthetic). Any other organization answers 404. Enforced by database triggers as well as the access resolver; trial-only accounts cannot be platform administrators. Lifting the restriction forces a password change and ends its sessions. |
| Disabled | Sign-in fails with the same response as a wrong password; every session and every API key the account created is revoked at once. Re-enabling does not restore revoked keys. |

Usernames: 3–30 letters, digits, dots, underscores; case-insensitive (stored lower-case, the administrator's casing kept for display). Accounts without an email get a placeholder address under the reserved `.invalid` domain (RFC 6761) because Better Auth requires one; it is never shown, emailed, or marked verified.

**Passwords** are never passed as command-line arguments. Commands that set one read `ORYN_PROVISION_PASSWORD`, or prompt without echo when run in a terminal, or with `--generate-password` generate a 144-bit random password and print it **once**. Better Auth hashes it (scrypt); it is never logged or written to the audit trail. The web UI always generates temporary passwords and shows them once.

**Initial trial account** (development or a dedicated trial environment):

```bash
# Creates the trial workspace "oryn-trial" (synthetic, with three synthetic sample fields when
# --demo-areas is given) and the trial-only, read-only account OrynTest, a viewer confined to it.
ORYN_PROVISION_PASSWORD='<the trial password>' npm run oryn:accounts -- provision-trial --username OrynTest --demo-areas
npm run worker   # fetches public imagery for the sample fields
```

Re-running is safe: an existing workspace and account are left as they are — the password is **not** reset and no duplicate is created (it only adds a missing membership). With `NODE_ENV=production` the command also requires `--allow-production`. Prefix the command with a space (or clear the variable afterwards) if your shell records history.

**Partner accounts:**

```bash
npm run oryn:accounts -- create --username jdoe --name "Jane Doe" --org tarboro-nc --role viewer --generate-password
#   --role viewer|field_operator|analyst|auditor|org_admin   (default viewer — grant the least the partner needs)
#   --email jane@example.org   only a real address the partner controls (enables emailed password reset)
#   --trial-only               confine to trial workspaces
npm run oryn:accounts -- set-role       --user jdoe --org tarboro-nc --role analyst
npm run oryn:accounts -- remove-member  --user jdoe --org tarboro-nc
npm run oryn:accounts -- reset-password --user jdoe --generate-password   # sessions revoked; change required
npm run oryn:accounts -- revoke-sessions --user jdoe
npm run oryn:accounts -- disable --user jdoe --reason "Contract ended"
npm run oryn:accounts -- enable  --user jdoe
npm run oryn:accounts -- trial-only --user jdoe --off                     # convert a trial account; change required
npm run oryn:accounts -- set-username --user person@example.org --username person   # existing email account
npm run oryn:accounts -- list
```

Deliver temporary passwords through a different channel from the username. None of these commands grants platform administration (`oryn:admin grant` is separate and refuses trial-only accounts).

**Audit:** every account action is recorded in the platform trail (`audit_events.org_id is null`: `account.create`, `account.password_reset`, `account.password_change`, `account.disable`, `account.enable`, `account.sessions_revoke`, `account.membership_set`, `account.trial_only_set`, `account.username_set`, `auth.sign_in`) and, for each organization the account belongs to, in that organization's trail (plus `member.add` / `member.update` / `member.remove`). The CLI records the operating-system user as `cli:<user>`.

**Sign-in rate limit:** 5 attempts per minute per client address, separately for `/sign-in/username` and `/sign-in/email`, stored in the database. The address comes from `X-Forwarded-For` when it holds exactly one address (e.g. Vercel); behind a proxy chain set `ORYN_TRUSTED_PROXIES` (CIDRs), otherwise every client shares one bucket.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `/login` says the platform is not configured | `DATABASE_URL` unset in this environment |
| Sign-in returns 429 | Rate limit (5/min per address and sign-in path). Wait, or clear `auth_rate_limit` in development. If *everyone* is limited at once, the proxy's `X-Forwarded-For` chain is not trusted — set `ORYN_TRUSTED_PROXIES` |
| A partner signs in but lands on "Your account" | Their password was issued by an administrator and must be changed first (by design) |
| A trial account sees 404 for an organization | Trial-only accounts open trial workspaces only (by design) |
| Pages load but every query returns nothing | App connects as a role that is not a member of `oryn_app_role`, or `app.org_id` not set (all access goes through `withTenant`) |
| `permission denied for table …` after a migration | New table created by a role other than the schema owner; default privileges apply only to objects created by the owner |
| Map is blank | `public/vendor/maplibre/*` missing — run `node scripts/copy-vendor.mjs` (runs automatically before `dev`/`build`); or the CSP blocks a newly added tile host (`src/proxy.ts`) |
| Areas never get imagery | Worker not running; check Processing → jobs, and Data sources for provider errors |
| “Only N% of the area was cloud-free” on most images | Expected in cloudy seasons; adjust the area's scene-cloud limit or rely on Sentinel-1 radar |
| `implausible_reflectance` failures | Provider scale/offset metadata does not match pixel values — the analytics refused rather than produce wrong NDVI; check the provider adapter's scaling handling |
| Open-Meteo disabled in production | Free API is non-commercial; set `OPEN_METEO_API_KEY` |
| GDELT `rate_limited` | GDELT allows one request per 5 s per client address and penalizes bursts. ORYN spaces requests across all processes (`provider_request_slots`), never retries a 429 immediately, and after one puts GDELT in a 10-minute cooldown that every process honours; the failed context job is retried after it. A 429 for a lone request means the egress address itself is throttled (seen from the development network) — verify from production with `oryn:verify -- gdelt` before enabling it. |
| A context sync shows `skipped` | The provider was not called (not configured, not verified, licence gate, or the area stopped using it) — nothing was ingested, and the sync run says why |
| Web or worker exits at startup with `Startup refused: …` | Production preflight found an unsafe configuration; the `preflight` log lines name each problem (docs/DEPLOYMENT.md) |
