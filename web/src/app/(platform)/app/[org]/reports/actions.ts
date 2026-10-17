"use server";

import { revalidatePath } from "next/cache";
import { orgAction } from "@/server/authz/next";
import { createExport } from "@/server/exports/service";
import { createReport } from "@/server/reports/service";

export async function createReportAction(slug: string, input: { type: string; aoiId: string | null; from?: string; to?: string; ai?: boolean }) {
  const r = await orgAction(slug, "reports.generate", (access) =>
    createReport(access, {
      type: input.type as never,
      aoiId: input.aoiId,
      params: { ...(input.from ? { from: input.from } : {}), ...(input.to ? { to: input.to } : {}), ai_summary: Boolean(input.ai) },
    }),
  );
  revalidatePath(`/app/${slug}/reports`);
  return r;
}

export async function createExportAction(slug: string, input: { type: string; subject: string; params: Record<string, unknown> }) {
  const r = await orgAction(slug, "exports.create", (access) => createExport(access, input as never));
  revalidatePath(`/app/${slug}/reports`);
  return r;
}
