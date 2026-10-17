import { orgApi } from "@/server/authz/next";
import { deleteScene } from "@/server/scenes/service";

export const runtime = "nodejs";

/** Delete a scene (its author, or an organization administrator). */
export const DELETE = orgApi<{ org: string; id: string }>("results.read", async (_req, { access }, { id }) => {
  await deleteScene(access, id);
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
});
