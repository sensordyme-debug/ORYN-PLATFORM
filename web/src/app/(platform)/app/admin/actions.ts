"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser, requestMeta } from "@/server/auth/session";
import { toActionError, type ActionResult } from "@/server/authz/next";
import { createOrganization, invitePlatformOrgAdmin } from "@/server/orgs/service";

export async function createOrgAction(_: unknown, form: FormData): Promise<ActionResult<{ slug: string; link: string | null }>> {
  try {
    const user = await getSessionUser();
    if (!user?.isPlatformAdmin || user.mustChangePassword) return { ok: false, error: "Only platform administrators can create organizations.", code: "forbidden" };
    const meta = await requestMeta();
    const org = await createOrganization(
      user,
      {
        slug: String(form.get("slug") ?? ""),
        name: String(form.get("name") ?? ""),
        kind: String(form.get("kind") ?? "") as "agriculture",
        isSynthetic: form.get("synthetic") === "on",
      },
      meta,
    );
    const adminEmail = String(form.get("adminEmail") ?? "").trim();
    const invite = adminEmail ? await invitePlatformOrgAdmin(user, org.id, adminEmail, meta) : null;
    revalidatePath("/app/admin");
    return { ok: true, data: { slug: org.slug, link: invite?.link ?? null } };
  } catch (err) {
    return toActionError(err);
  }
}

export async function inviteOrgAdminAction(orgId: string, email: string): Promise<ActionResult<{ link: string }>> {
  try {
    const user = await getSessionUser();
    if (!user?.isPlatformAdmin || user.mustChangePassword) return { ok: false, error: "Only platform administrators can do this.", code: "forbidden" };
    const r = await invitePlatformOrgAdmin(user, orgId, email, await requestMeta());
    return { ok: true, data: { link: r.link } };
  } catch (err) {
    return toActionError(err);
  }
}
