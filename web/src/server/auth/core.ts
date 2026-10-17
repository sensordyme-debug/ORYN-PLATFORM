/**
 * A Better Auth instance without Next.js integrations, for server code that
 * needs Better Auth's own primitives — password hashing, account and session
 * storage — outside an HTTP request: account provisioning (platform admin UI
 * and CLI), invitation acceptance, tests.
 *
 * HTTP requests and Server Actions that set cookies use getAuth()
 * (src/server/auth/auth.ts); both share the same options and database.
 */
import { betterAuth } from "better-auth";
import { buildAuthOptions } from "@/server/auth/options";

type CoreAuth = ReturnType<typeof createCoreAuth>;
const createCoreAuth = () => betterAuth(buildAuthOptions());

type GlobalWithCoreAuth = typeof globalThis & { __orynCoreAuth?: CoreAuth };
const g = globalThis as GlobalWithCoreAuth;

export function coreAuth(): CoreAuth {
  if (!g.__orynCoreAuth) g.__orynCoreAuth = createCoreAuth();
  return g.__orynCoreAuth;
}

export type AuthContext = Awaited<CoreAuth["$context"]>;

export function authContext(): Promise<AuthContext> {
  return coreAuth().$context;
}
