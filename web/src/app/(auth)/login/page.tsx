import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/login-form";
import { Notice } from "@/components/platform/ui";
import { getSessionUser } from "@/server/auth/session";
import { env } from "@/server/config/env";
import { safeNext } from "@/lib/safe-redirect";

export const metadata: Metadata = { title: "Sign in", robots: { index: false } };

export default async function LoginPage(props: PageProps<"/login">) {
  const sp = await props.searchParams;
  const next = safeNext(typeof sp.next === "string" ? sp.next : null);
  if (!env.databaseConfigured()) {
    return (
      <Notice tone="warn" title="The ORYN platform is not configured on this deployment">
        Set DATABASE_URL and BETTER_AUTH_SECRET (see README → Platform setup) to enable sign-in.
      </Notice>
    );
  }
  const user = await getSessionUser();
  if (user) redirect(next);
  return (
    <div>
      <h1 className="text-[1.5rem] font-medium tracking-[-0.025em]">Sign in to ORYN</h1>
      <p className="mt-1.5 text-[0.875rem] text-bone-50/55">
        Partner accounts are issued by ORYN administrators. There is no public sign-up.
      </p>
      <LoginForm next={next} resetAvailable={Boolean(env.resendApiKey() && env.emailFrom())} />
    </div>
  );
}
