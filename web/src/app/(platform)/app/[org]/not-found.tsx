"use client";

import { useParams } from "next/navigation";
import { EmptyState, LinkButton } from "@/components/platform/ui";

/**
 * A record page whose record is missing or not available to this member
 * (getPageRecord). Rendered inside the workspace shell; it does not say
 * which of those applies. Non-members never reach it: the org layout sends
 * them to the site's 404 before the shell renders.
 */
export default function OrgRecordNotFound() {
  const { org } = useParams<{ org: string }>();
  return (
    <EmptyState
      title="This record isn't available"
      className="mt-6"
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <LinkButton href={`/app/${org}`} variant="primary">Go to the overview</LinkButton>
          <LinkButton href={`/app/${org}/map`}>Open the map workspace</LinkButton>
        </div>
      }
    >
      It may not exist, it may have been removed, or your role or assigned areas may not include it. Check the link, or ask an
      administrator of this organization for access.
    </EmptyState>
  );
}
