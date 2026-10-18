"use client";

import { useParams } from "next/navigation";
import { Button, LinkButton, Notice } from "@/components/platform/ui";

/**
 * An unexpected failure while rendering a workspace page. The shell stays, so
 * the member can move on; the message never includes server details (in
 * production Next.js forwards only a digest, which matches the server log).
 */
export default function OrgPageError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const { org } = useParams<{ org: string }>();
  return (
    <div className="mt-6 flex max-w-2xl flex-col gap-4">
      <Notice tone="error" title="This page couldn't load">
        Something went wrong while loading it. Try again; if it keeps failing, give an administrator the reference below.
        {error.digest ? <span className="mt-2 block font-mono text-[0.75rem] text-bone-50/70">Reference {error.digest}</span> : null}
      </Notice>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => retry()}>Try again</Button>
        <LinkButton href={`/app/${org}`}>Go to the overview</LinkButton>
      </div>
    </div>
  );
}
