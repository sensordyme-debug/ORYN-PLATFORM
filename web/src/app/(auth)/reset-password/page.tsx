import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/auth/password";
import { Notice } from "@/components/platform/ui";

export const metadata: Metadata = { title: "Choose a new password", robots: { index: false } };

export default async function ResetPasswordPage(props: PageProps<"/reset-password">) {
  const sp = await props.searchParams;
  const token = typeof sp.token === "string" ? sp.token : null;
  return (
    <div>
      <h1 className="text-[1.5rem] font-medium tracking-[-0.025em]">Choose a new password</h1>
      {token ? <ResetPasswordForm token={token} /> : <Notice tone="warn" className="mt-5">This reset link is incomplete or has expired.</Notice>}
    </div>
  );
}
