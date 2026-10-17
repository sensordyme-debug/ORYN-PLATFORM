"use server";

import { revalidatePath } from "next/cache";
import { orgAction } from "@/server/authz/next";
import { controlJob } from "@/server/jobs/views";

export async function controlJobAction(slug: string, jobId: string, action: "retry" | "cancel") {
  const r = await orgAction(slug, "jobs.manage", (access) => controlJob(access, jobId, action));
  revalidatePath(`/app/${slug}/processing`);
  return r;
}
