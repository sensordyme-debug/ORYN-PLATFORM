"use server";

import { revalidatePath } from "next/cache";
import { orgAction } from "@/server/authz/next";
import { completeOnboarding } from "@/server/orgs/service";

export async function completeOnboardingAction(slug: string) {
  const r = await orgAction(slug, "org.manage", (access) => completeOnboarding(access).then(() => null));
  revalidatePath(`/app/${slug}`);
  return r;
}
