# Security architecture, threat model, and remaining risks

**Status:** implemented controls are listed below with where they live. ORYN has **not** been independently audited or penetration-tested and holds **no** compliance authorization (FedRAMP, StateRAMP, CJIS, SOC 2, ISO 27001). It is not suitable for classified information. A public-sector deployment would require a separately scoped assessment and authorization process; the control mapping at the end is a starting point for that work, not a claim.

## Assets and trust boundaries

| Asset | Sensitivity |
| --- | --- |
| Customer AOI boundaries, notes, detections, alerts, reports | Confidential to the tenant |
| User accounts, sessions, API keys, invitations | Credentials |
| Provider credentials (Earthdata, CDSE, Resend, Anthropic, S3) | Secrets — server only |
| Audit trail | Integrity-critical |
| Public provider data (imagery metadata, weather, news) | Public, but licence-bound |

Boundaries: browser ↔ Next.js server; Next.js/worker ↔ PostgreSQL; server ↔ external providers; server ↔ object storage.

## Threats considered and controls

| Threat | Control | Where |
| --- | --- | --- |
| Cross-tenant access via guessed ids, API manipulation, missing filters | Server-side org resolution per request; explicit org filters in every query; **PostgreSQL RLS** on every tenant table with a least-privilege app role (no BYPASSRLS); unknown org ≡ non-member (404) | `src/server/authz/access.ts`, `src/server/db/client.ts`, `db/migrations/*` (`enable_tenant_rls`) |
| Privilege escalation within a tenant | Role → permission matrix enforced server-side (`access.assert`) in services, actions, and API routes; UI only hides what the server would refuse; last-admin protection; AOI-restricted members | `src/lib/authz.ts`, services |
| Platform admin overreach | Platform admins get no implicit tenant access; org creation and first-admin invitations are audited in the org's trail; admins are granted only by an operator CLI with owner credentials | `src/server/orgs/service.ts`, `scripts/oryn/admin.ts` |
| Account takeover | Better Auth (scrypt password hashing, opaque DB sessions, 12 h lifetime, cookie cache off so revocation is immediate); min 12-character passwords; **database-backed rate limiting** (5 sign-ins/min per address, per sign-in path); administrator-issued passwords must be changed before any non-trial organization opens; password change ends every other session; sign-ins audited | `src/server/auth/options.ts`, `src/server/accounts/*` |
| Username / account enumeration | Unknown username, wrong password, disabled account, and malformed username all produce the same form message; Better Auth hashes a dummy password for unknown usernames (timing); disabled accounts are refused only after the password verifies, with the wrong-password response; `/is-username-available` and every other non-allowlisted auth endpoint answer 404 | `src/server/auth/options.ts`, `src/server/auth/http.ts`, `src/components/auth/login-form.tsx` |
| Unauthorized sign-up | No public registration, enforced three times: the auth route serves only an allowlist (sign-in, sign-out, session, emailed reset); Better Auth `disableSignUp` + `disabledPaths`; a database hook refuses any user creation outside a trusted server flow (platform admin, operator CLI, invitation acceptance) that names the exact address. Invitation sign-up is a server action that takes the address from the invitation the **token** identifies — knowing an invited address is not enough (this closed an account pre-registration gap in the earlier browser-side sign-up) | `src/server/auth/*`, `src/app/(auth)/invite/[token]/actions.ts` |
| Disabled or departed partners | Disable revokes all sessions and the API keys the account created; a session presented for a disabled account is revoked on sight; disabled accounts receive no email notifications | `src/server/accounts/service.ts`, `src/server/auth/session.ts` |
| Trial account reaching real data | Trial-only accounts are confined to trial organizations, which the database requires to be synthetic; enforced by triggers (membership, flag changes, platform-admin grants) and by the access resolver (other orgs answer 404); the trial role is read-only by default; lifting the restriction forces a password change | `db/migrations/0006`, `src/server/authz/access.ts` |
| Account administration abuse | Only platform administrators (who have themselves changed any issued password) or operators with owner credentials manage accounts; partner creation never grants platform administration; every change audited (platform trail + each affected organization's trail) without passwords | `src/server/accounts/service.ts`, `src/app/(platform)/app/admin/accounts` |
| CSRF | Better Auth Origin and Fetch-Metadata checks on auth endpoints; Next.js Server Actions compare Origin and Host; SameSite=Lax cookies; JSON APIs require session cookie or bearer key | framework + config |
| XSS | React escaping; no `dangerouslySetInnerHTML` with user data; nonce-based CSP (`script-src 'nonce-…' 'strict-dynamic'`) on platform and auth routes | `src/proxy.ts` |
| Clickjacking | `frame-ancestors 'none'` (platform), `X-Frame-Options: SAMEORIGIN` (site) | `src/proxy.ts`, `next.config.ts` |
| API key misuse | Keys scoped to one org and an allowlisted set of permissions, optional expiry, revocable, SHA-256 stored, constant-time comparison, last-used tracking, every use attributed in audit | `src/server/authz/access.ts` |
| Injection | Parameterized SQL only (postgres.js tagged templates); zod validation of all inputs; geometry validated in PostGIS; identifiers never interpolated from input | services |
| SSRF via catalog-supplied URLs | Asset hrefs must be public HTTPS (no private/loopback/link-local/metadata hosts, no embedded credentials); provider endpoints come from configuration only | `src/server/net.ts`, providers |
| Path traversal in storage | Storage keys are validated and always derived from authorized DB rows, never request input | `src/server/storage.ts` |
| Malicious uploads | GeoJSON only, size limit, parsed as data (never executed or served back raw), schema validation, SHA-256 recorded, audited | `src/server/uploads/service.ts` |
| Audit tampering | `audit_events` is append-only: app role has no UPDATE/DELETE; trigger blocks updates/deletes; purges only via a definer function enforcing ≥ 90 days; orgs with history cannot be deleted | `db/migrations/0001`, `0005` |
| Secret leakage | Secrets only in server env; only `NEXT_PUBLIC_*` reach the browser; structured logs redact credential-like keys, bearer tokens, signed URL query strings, and API keys; SAS signatures never logged | `src/server/log.ts`, `src/server/providers/http.ts` |
| Abuse / resource exhaustion | AOI area cap, vertex cap, raster pixel budget, upload size cap, API rate limits, job timeouts and retry caps, Overpass bbox caps | config + services |
| Unsafe production configuration | Startup preflight (web and worker exit non-zero): refuses synthetic seeding, development/test secrets, short or known auth secrets, a non-HTTPS or localhost auth URL, the owner role as the app role, an app role that is superuser or has BYPASSRLS or is not in `oryn_app_role`, any tenant table without RLS, local file storage, plain-HTTP object storage, and pending migrations. The migration runner refuses the app role. Readiness proves database, migrations, and storage work | `src/server/config/preflight.ts`, `src/instrumentation*.ts`, `scripts/oryn/worker.ts`, `src/server/db/migrate.ts` |
| Unverified integrations sending data | Email, GDELT, NASA HLS reads, and AI summaries stay off in production until verified in that deployment and listed in `ORYN_VERIFIED_INTEGRATIONS` | `src/server/integrations.ts` |
| Object storage exposure | Private bucket; no public or presigned URLs (downloads stream through authorized routes); SSE-S3 requested on every write; `oryn:verify -- storage` confirms anonymous reads are refused | `src/server/storage.ts`, `scripts/oryn/verify.ts` |
| Data exfiltration through exports | `exports.create` permission + org-level export switch; tenant-scoped generation; licence notes attached; download audited; expiry | `src/server/exports` |
| Misleading output | Result classes kept distinct; candidate changes labelled unverified; unusable data recorded with reasons; historical/reprocessed data never notified as new; AI narrative constrained to cited findings | analytics, alerts, reports |

## Remaining risks and work items

* **No MFA yet.** Better Auth provides a TOTP plugin; enabling it needs schema additions and UI. Enterprise SSO (SAML/OIDC) is not configured.
* **Shared trial account.** A trial password handed to several people is effectively public: anyone holding it can sign in, read the trial workspace's synthetic data, change its password (locking others out until an administrator resets it), and consume sign-in attempts. Its blast radius is limited to trial workspaces by the controls above. Use a strong, per-environment password, rotate it with `reset-password`, and prefer individual accounts for anything beyond a demonstration. A password that contains the username (as a short demonstration password might) should not be used outside a local or dedicated trial environment.
* **No per-account lockout.** Sign-in is throttled per client address, not per account (a per-account lock would let anyone lock out a shared or known username). A distributed guessing attack is bounded only by password strength — another reason for MFA.
* **Client address for rate limits** comes from `X-Forwarded-For`; when the app is reachable without a proxy that overwrites that header, a client can choose its own bucket. Deploy behind a proxy and set `ORYN_TRUSTED_PROXIES` for multi-hop chains.
* **Password change attempts** from an existing session are limited in memory per instance (5 per 15 minutes per account).
* **API rate limiting for `/api/v1` is per instance (in memory).** Use an edge/WAF rule in multi-instance deployments. Auth endpoints use the database-backed limiter.
* **CSP:** `style-src 'unsafe-inline'` is required by React style props and MapLibre; the static marketing pages use the global headers without a CSP.
* **No malware scanning** of uploads (mitigated by accepting only GeoJSON parsed as data). Add scanning before accepting binary formats.
* **SSRF guard does not resolve DNS**; a hostname that resolves to a private address would pass. Run workers in a network segment without access to internal services or metadata endpoints.
* **Encryption at rest** depends on the deployment: managed PostgreSQL and S3 (objects are written with SSE-S3) provide it; the local storage driver does not.
* **Backups** are not performed by the application (see `docs/OPERATIONS.md`).
* **S3 compatibility** is verified against SeaweedFS (SigV4, SSE-S3, private bucket) only; run `oryn:verify -- storage` against the real provider in each deployment.
* **Container images** are built from `node:22-bookworm-slim` and have not been scanned for OS or dependency vulnerabilities; add image scanning and rebuild regularly for base-image patches. The worker image carries all production dependencies (≈1.3 GB) — a smaller dependency set would reduce its attack surface.
* **Preflight is a guard, not a guarantee:** it recognises known development values and obvious misconfiguration; it cannot tell whether a secret has leaked or a password is weak in general.
* **Audit trail** is append-only in the database but not cryptographically chained or shipped to an external WORM store/SIEM.
* **Dependency audit:** `npm audit` reports high-severity advisories only in development tooling (`eslint-config-next` → `braces`); no runtime dependency findings at the time of writing. Re-run on every release.
* **Provider trust:** ORYN trusts provider catalogs for metadata; a plausibility check refuses implausible reflectance scaling, but other metadata errors could propagate.
* **Session cookies** are `Secure` only when `NODE_ENV=production`; always serve production over HTTPS (HSTS is set in production).

## Mapping to NIST SP 800-53 (orientation only)

| Family | Relevant implemented mechanisms |
| --- | --- |
| AC (Access Control) | Role matrix, least-privilege DB role, RLS, AOI restrictions, API key scopes (AC-2, AC-3, AC-6) |
| AU (Audit) | Append-only audit trail of auth, admin, data, export, and download events with actor, time, IP, user agent; retention controls (AU-2, AU-3, AU-9, AU-11) |
| IA (Identification & Authentication) | Password policy, hashed credentials, administrator-provisioned or invitation-only enrolment, change of administrator-issued passwords at first use, session lifetime (IA-2, IA-5) — **MFA not yet implemented (IA-2(1))** |
| SC (System & Communications) | CSP, HSTS, secure cookies, SSRF guard, TLS to providers (SC-8, SC-13 depend on deployment) |
| SI (System & Information Integrity) | Input validation, plausibility checks, error handling without leakage (SI-10, SI-11) |
| CM / CP | Migrations in source control, reproducible config; contingency planning depends on deployment (`docs/OPERATIONS.md`) |

Any authorization effort must verify each control in the deployed environment, add missing controls (MFA, centralized logging, vulnerability management, incident response), and document inherited controls from the hosting provider.
