"use client";

import { useState } from "react";
import { controlJobAction } from "@/app/(platform)/app/[org]/processing/actions";
import { Button } from "@/components/platform/ui";

export function JobControl({ slug, jobId, action }: { slug: string; jobId: string; action: "retry" | "cancel" }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant={action === "cancel" ? "ghost" : "secondary"}
        disabled={pending}
        onClick={async () => {
          setPending(true);
          const r = await controlJobAction(slug, jobId, action);
          setPending(false);
          setMsg(r.ok ? (r.data ? (action === "retry" ? "Requeued" : "Cancellation requested") : "No change") : r.error);
        }}
      >
        {action === "retry" ? "Retry" : "Cancel"}
      </Button>
      {msg ? <span className="text-[0.6875rem] text-bone-50/55">{msg}</span> : null}
    </span>
  );
}
