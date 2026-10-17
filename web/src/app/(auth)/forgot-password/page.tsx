import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/auth/password";
import { Notice } from "@/components/platform/ui";
import { emailConfigured } from "@/server/email";

export const metadata: Metadata = { title: "Reset password", robots: { index: false } };
// Whether email is configured is a runtime fact, not a build-time one.
export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
  return (
    <div>
      <h1 className="text-[1.5rem] font-medium tracking-[-0.025em]">Reset your password</h1>
      {emailConfigured() ? (
        <ForgotPasswordForm />
      ) : (
        <Notice tone="info" className="mt-5">
          Email delivery is not configured on this deployment, so self-service reset is unavailable. Ask your organization
          administrator to re-invite you.
        </Notice>
      )}
    </div>
  );
}
