/**
 * Saved map scenes (db/migrations/0008_saved_scenes.sql).
 *
 *  - Any member who can read results may save a private scene; sharing one
 *    with the organization needs notes.write (the permission for shared,
 *    user-authored content). API keys can only manage organization scenes.
 *  - Basemap and overlay ids must exist in the layer catalog; a selected area
 *    must exist in the organization and be visible to the author.
 *  - Listing re-checks the selected area against the viewer: an area the
 *    viewer cannot see (restricted membership, archived) is removed from the
 *    returned state and flagged, so a shared scene never reveals it.
 *  - Private scenes are hidden from other users by row-level security.
 */
import { z } from "zod";
import { MAP_LAYERS } from "@/lib/map-layers";
import { sceneInputSchema, sceneStateSchema, type SceneInput, type SceneState } from "@/lib/scenes";
import { recordAudit } from "@/server/audit";
import { AccessError, type OrgAccess } from "@/server/authz/access";
import { aoiVisibleTo } from "@/server/aois/service";
import { jsonb } from "@/server/db/client";
import { DomainError, notFoundError } from "@/server/errors";

export const MAX_SCENES_PER_ORG = 200;

export type SceneView = {
  id: string;
  name: string;
  description: string;
  visibility: "private" | "org";
  state: SceneState;
  /** The saved area is not available to this viewer (or no longer exists); it was removed from `state`. */
  aoiUnavailable: boolean;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
  canDelete: boolean;
};

const BASEMAP_IDS = new Set(MAP_LAYERS.filter((l) => l.role === "basemap").map((l) => l.id));
const OVERLAY_IDS = new Set(MAP_LAYERS.filter((l) => l.role === "overlay").map((l) => l.id));

function invalid(err: z.ZodError): DomainError {
  const fields: Record<string, string> = {};
  for (const i of err.issues) fields[i.path.join(".") || "scene"] = i.message;
  return new DomainError("invalid", "The scene is not valid.", 422, fields);
}

function userIdOf(access: OrgAccess): string | null {
  return access.principal.type === "user" ? access.principal.userId : null;
}

export async function listScenes(access: OrgAccess): Promise<SceneView[]> {
  access.assert("results.read");
  return access.tx(async (tx) => {
    const rows = await tx<
      { id: string; name: string; description: string; visibility: "private" | "org"; state: unknown; created_by: string | null; author: string | null; created_at: Date; updated_at: Date; aoi_ok: boolean | null }[]
    >`
      select s.id, s.name, s.description, s.visibility, s.state, s.created_by, u.name as author, s.created_at, s.updated_at,
             case when s.state->>'aoiId' is null then null
                  else exists (select 1 from aois a where a.org_id = ${access.org.id} and a.id::text = s.state->>'aoiId' and a.status = 'active' ${aoiVisibleTo(tx, access)})
             end as aoi_ok
        from saved_scenes s left join auth_user u on u.id = s.created_by
       where s.org_id = ${access.org.id}
       order by s.created_at desc limit ${MAX_SCENES_PER_ORG}`;
    const me = userIdOf(access);
    return rows.flatMap((r) => {
      const parsed = sceneStateSchema.safeParse(r.state);
      if (!parsed.success) return []; // never surface a state the current schema cannot vouch for
      const aoiUnavailable = r.aoi_ok === false;
      const state = aoiUnavailable ? { ...parsed.data, aoiId: null, imagery: null } : parsed.data;
      return [
        {
          id: r.id,
          name: r.name,
          description: r.description,
          visibility: r.visibility,
          state,
          aoiUnavailable,
          createdBy: r.created_by,
          createdByName: r.author,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          canDelete: (me !== null && r.created_by === me) || access.can("org.manage"),
        },
      ];
    });
  });
}

export async function createScene(access: OrgAccess, raw: SceneInput): Promise<SceneView> {
  access.assert("results.read");
  const parsed = sceneInputSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error);
  const input = parsed.data;
  const me = userIdOf(access);
  if (input.visibility === "org") access.assert("notes.write");
  if (input.visibility === "private" && !me) throw new DomainError("invalid", "API keys can only save organization scenes.", 422, { visibility: "Use org." });
  const { state } = input;
  if (state.basemap && !BASEMAP_IDS.has(state.basemap)) throw new DomainError("invalid", "Unknown basemap.", 422, { "state.basemap": "Unknown basemap." });
  const unknown = state.overlays.filter((o) => !OVERLAY_IDS.has(o));
  if (unknown.length) throw new DomainError("invalid", "Unknown overlay.", 422, { "state.overlays": `Unknown: ${unknown.join(", ")}` });

  const id = await access.tx(async (tx) => {
    if (state.aoiId) {
      const [a] = await tx<{ id: string }[]>`
        select a.id from aois a where a.org_id = ${access.org.id} and a.id = ${state.aoiId} ${aoiVisibleTo(tx, access)}`;
      if (!a) throw notFoundError("Area");
    }
    const [count] = await tx<{ n: number }[]>`select count(*)::int as n from saved_scenes where org_id = ${access.org.id}`;
    if (count!.n >= MAX_SCENES_PER_ORG) throw new DomainError("limit", `An organization can keep at most ${MAX_SCENES_PER_ORG} scenes; delete some first.`, 409);
    const [row] = await tx<{ id: string }[]>`
      insert into saved_scenes (org_id, name, description, visibility, state, created_by)
      values (${access.org.id}, ${input.name}, ${input.description}, ${input.visibility}, ${jsonb(state)}::jsonb, ${me})
      returning id`;
    await recordAudit(tx, {
      orgId: access.org.id,
      actor: access.auditActor(),
      action: "scene.create",
      targetType: "scene",
      targetId: row!.id,
      metadata: { name: input.name, visibility: input.visibility },
      ...access.meta,
    });
    return row!.id;
  });
  const scene = (await listScenes(access)).find((s) => s.id === id);
  if (!scene) throw notFoundError("Scene");
  return scene;
}

export async function deleteScene(access: OrgAccess, id: string): Promise<void> {
  access.assert("results.read");
  if (!z.uuid().safeParse(id).success) throw notFoundError("Scene");
  const me = userIdOf(access);
  await access.tx(async (tx) => {
    const [s] = await tx<{ created_by: string | null; name: string }[]>`select created_by, name from saved_scenes where id = ${id} and org_id = ${access.org.id}`;
    if (!s) throw notFoundError("Scene");
    if (!((me !== null && s.created_by === me) || access.can("org.manage"))) {
      throw new AccessError(403, "forbidden", "Only the scene's author or an organization administrator can delete it.");
    }
    await tx`delete from saved_scenes where id = ${id} and org_id = ${access.org.id}`;
    await recordAudit(tx, { orgId: access.org.id, actor: access.auditActor(), action: "scene.delete", targetType: "scene", targetId: id, metadata: { name: s.name }, ...access.meta });
  });
}
