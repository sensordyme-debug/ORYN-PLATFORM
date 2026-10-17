/**
 * Better Auth configuration shared by the Next.js app, CLI scripts, and tests.
 *
 * ORYN does not implement its own password hashing, session tokens, or CSRF
 * defenses — those come from Better Auth (scrypt password hashing, opaque
 * database-backed sessions, Origin and Fetch-Metadata checks). This module
 * only configures it:
 *
 *  - Accounts are provisioned, never self-registered. Better Auth's sign-up
 *    endpoint is disabled (`disableSignUp`, `disabledPaths`, and the HTTP
 *    allowlist in src/server/auth/http.ts), and the user-creation hook below
 *    refuses any creation that is not inside a trusted server-side flow
 *    (platform administrator, admin CLI, invitation acceptance, dev seed).
 *  - Sign-in is by username (Better Auth username plugin) or by email.
 *    Disabled accounts are refused before a session is created, with the same
 *    response as a wrong password.
 *  - Sessions are short-lived (12 h default) and stored in PostgreSQL so they
 *    can be revoked immediately; the cookie cache is disabled for that reason.
 *  - Rate limits are stored in the database so they hold across instances.
 *  - Telemetry is disabled.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { username } from "better-auth/plugins";
import { Pool } from "pg";
import { isPlaceholderEmail } from "@/lib/accounts";
import { env, isProduction } from "@/server/config/env";
import { pgConnectionOptions } from "@/server/db/tls";
import { emailConfigured, sendEmail } from "@/server/email";
import { log } from "@/server/log";

type GlobalWithPool = typeof globalThis & { __orynAuthPool?: Pool };
const g = globalThis as GlobalWithPool;

export function authPool(): Pool {
  if (!g.__orynAuthPool) {
    g.__orynAuthPool = new Pool({
      ...pgConnectionOptions(env.databaseUrl()),
      max: 5,
      idleTimeoutMillis: 30_000,
      application_name: "oryn-auth",
    });
  }
  return g.__orynAuthPool;
}

export async function closeAuthPool() {
  if (g.__orynAuthPool) {
    await g.__orynAuthPool.end();
    g.__orynAuthPool = undefined;
  }
}

/** Set while a trusted server-side flow creates a user (platform admin, admin CLI, invitation acceptance, dev seed). */
export const trustedUserCreation = new AsyncLocalStorage<{ reason: string; email: string }>();

export const AUTH_TABLES = {
  user: "auth_user",
  session: "auth_session",
  account: "auth_account",
  verification: "auth_verification",
  rateLimit: "auth_rate_limit",
} as const;

/**
 * Better Auth endpoints that must never be reachable over HTTP. The route
 * handler additionally serves only an allowlist (src/server/auth/http.ts);
 * this list keeps them closed if the handler is ever mounted differently.
 */
export const DISABLED_AUTH_PATHS = [
  "/sign-up/email",
  "/is-username-available",
  "/update-user",
  "/change-password",
  "/change-email",
  "/delete-user",
  "/link-social",
  "/unlink-account",
  "/sign-in/social",
  "/list-accounts",
  "/get-access-token",
  "/refresh-token",
  "/account-info",
];

const GENERIC_SIGN_IN_FAILURE = "Invalid username or password";

/** Runs one statement as a platform operation (app.system) on the auth pool. */
async function systemQuery(sql: string, params: unknown[]) {
  const client = await authPool().connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.system', 'on', true)");
    await client.query(sql, params);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export function buildAuthOptions(overrides: Partial<BetterAuthOptions> = {}): BetterAuthOptions {
  const baseURL = env.authBaseUrl();
  return {
    appName: "ORYN",
    secret: env.authSecret(),
    baseURL,
    basePath: "/api/auth",
    trustedOrigins: [baseURL, ...env.authTrustedOrigins()],
    database: authPool(),
    telemetry: { enabled: false },
    disabledPaths: DISABLED_AUTH_PATHS,
    // Usernames are lower-cased by the plugin; changing one is an administrator action.
    plugins: [username({ minUsernameLength: 3, maxUsernameLength: 30, immutableUsername: true })],
    user: { modelName: AUTH_TABLES.user },
    account: { modelName: AUTH_TABLES.account },
    verification: { modelName: AUTH_TABLES.verification },
    session: {
      modelName: AUTH_TABLES.session,
      expiresIn: env.sessionMaxAgeSeconds(),
      updateAge: 60 * 60,
      freshAge: 60 * 15,
      cookieCache: { enabled: false },
    },
    emailAndPassword: {
      enabled: true,
      // No public registration. Accounts are created server-side only.
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      autoSignIn: true,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 30,
      // Only offered when an email provider is configured; otherwise the
      // sign-in page tells users to ask their administrator.
      ...(emailConfigured()
        ? {
            sendResetPassword: async ({ user, url }: { user: { id: string; email: string }; url: string }) => {
              // Username-only accounts have no deliverable address, and disabled
              // accounts get nothing. The HTTP response is identical either way.
              if (isPlaceholderEmail(user.email)) return;
              const { rows } = await authPool().query<{ disabled: boolean }>("select auth_account_disabled($1) as disabled", [user.id]);
              if (rows[0]?.disabled) return;
              await sendEmail({
                to: [user.email],
                subject: "Reset your ORYN password",
                text: `A password reset was requested for your ORYN account.\n\nReset it within 30 minutes:\n${url}\n\nIf you did not request this, ignore this email; your password is unchanged.`,
              });
            },
          }
        : {}),
      // A reset through the emailed link proves control of the address: the
      // new password is the user's own, so the change requirement is met.
      onPasswordReset: async ({ user }) => {
        await systemQuery(
          `insert into account_controls (user_id, must_change_password, password_changed_at) values ($1, false, now())
           on conflict (user_id) do update set must_change_password = false, password_changed_at = now()`,
          [user.id],
        );
        await systemQuery(
          `insert into audit_events (org_id, actor_type, actor_user_id, action, target_type, target_id)
           values (null, 'user', $1, 'account.password_reset_by_email', 'user', $1)`,
          [user.id],
        ).catch((err) => log.error("auth.audit_password_reset_failed", { err }));
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: AUTH_TABLES.rateLimit,
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-in/username": { window: 60, max: 5 },
        "/request-password-reset": { window: 60 * 15, max: 3 },
        "/reset-password": { window: 60 * 15, max: 5 },
        "/change-password": { window: 60 * 15, max: 5 },
      },
    },
    advanced: {
      ...(env.authTrustedProxies().length || env.authClientIpHeader()
        ? {
            ipAddress: {
              ...(env.authTrustedProxies().length ? { trustedProxies: env.authTrustedProxies() } : {}),
              ...(env.authClientIpHeader() ? { ipAddressHeaders: [env.authClientIpHeader()!] } : {}),
            },
          }
        : {}),
      cookiePrefix: "oryn",
      useSecureCookies: isProduction(),
      defaultCookieAttributes: { sameSite: "lax", httpOnly: true },
    },
    databaseHooks: {
      session: {
        create: {
          // Disabled accounts never get a session. Runs only after the password
          // was verified, and answers exactly like a wrong password so the
          // response does not reveal the account's state.
          before: async (session) => {
            const { rows } = await authPool().query<{ disabled: boolean }>("select auth_account_disabled($1) as disabled", [session.userId]);
            if (rows[0]?.disabled) {
              log.warn("auth.sign_in_refused", { reason: "account_disabled", userId: session.userId });
              throw new APIError("UNAUTHORIZED", { message: GENERIC_SIGN_IN_FAILURE, code: "INVALID_USERNAME_OR_PASSWORD" });
            }
            return { data: session };
          },
          // Platform-level audit of every sign-in (org_id null). Runs in a
          // short transaction so the RLS insert policy sees app.user_id.
          after: async (session) => {
            const client = await authPool().connect();
            try {
              await client.query("begin");
              await client.query("select set_config('app.user_id', $1, true)", [session.userId]);
              await client.query(
                `insert into audit_events (org_id, actor_type, actor_user_id, action, target_type, target_id, ip, user_agent)
                 values (null, 'user', $1, 'auth.sign_in', 'session', $2, $3, $4)`,
                [session.userId, session.id, session.ipAddress ?? null, session.userAgent?.slice(0, 300) ?? null],
              );
              await client.query("commit");
            } catch (err) {
              await client.query("rollback").catch(() => {});
              log.error("auth.audit_sign_in_failed", { err });
            } finally {
              client.release();
            }
          },
        },
      },
      user: {
        create: {
          // Every account is created by a trusted server-side flow that names
          // the address it is creating; anything else is refused.
          before: async (user) => {
            const trusted = trustedUserCreation.getStore();
            const email = String(user.email ?? "").toLowerCase();
            if (trusted && trusted.email.toLowerCase() === email) return { data: user };
            log.warn("auth.signup_rejected", { reason: "not_provisioned" });
            return false;
          },
        },
      },
    },
    ...overrides,
  };
}
