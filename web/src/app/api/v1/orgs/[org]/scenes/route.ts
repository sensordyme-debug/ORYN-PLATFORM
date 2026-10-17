import { orgApi } from "@/server/authz/next";
import { ok, readJson } from "@/server/http";
import { createScene, listScenes } from "@/server/scenes/service";
import type { SceneInput } from "@/lib/scenes";

export const runtime = "nodejs";

/** Saved map scenes visible to the caller (private scenes only to their author). */
export const GET = orgApi("results.read", async (_req, { access }) => ok({ items: await listScenes(access) }));

/** Save a scene. Sharing with the organization needs notes.write (checked by the service). */
export const POST = orgApi(
  "results.read",
  async (req, { access }) => ok(await createScene(access, (await readJson(req, 32_000)) as SceneInput), { status: 201 }),
  { rateLimit: { limit: 30, windowMs: 60_000 } },
);
