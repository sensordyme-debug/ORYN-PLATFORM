import "server-only";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { buildAuthOptions } from "@/server/auth/options";

type Auth = ReturnType<typeof createAuth>;

function createAuth() {
  const base = buildAuthOptions();
  // nextCookies must be the last plugin so Server Actions can set cookies.
  return betterAuth({ ...base, plugins: [...(base.plugins ?? []), nextCookies()] });
}

type GlobalWithAuth = typeof globalThis & { __orynAuth?: Auth };
const g = globalThis as GlobalWithAuth;

/** Lazily constructed so the marketing site builds without platform configuration. */
export function getAuth(): Auth {
  if (!g.__orynAuth) g.__orynAuth = createAuth();
  return g.__orynAuth;
}
