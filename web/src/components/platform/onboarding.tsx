"use client";

import { useState } from "react";
import { completeOnboardingAction } from "@/app/(platform)/app/[org]/actions";
import { Button } from "@/components/platform/ui";

export function CompleteOnboardingButton({ slug }: { slug: string }) {
  const [pending, setPending] = useState(false);
  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await completeOnboardingAction(slug);
        setPending(false);
      }}
    >
      Hide checklist — setup is complete
    </Button>
  );
}
