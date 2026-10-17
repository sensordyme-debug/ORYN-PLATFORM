import { orgApi } from "@/server/authz/next";
import { ok, readJson, searchParam } from "@/server/http";
import { importUploadAsLayer, listReferenceLayers } from "@/server/reference/service";

export const runtime = "nodejs";

export const GET = orgApi("results.read", async (req, { access }) => ok({ items: await listReferenceLayers(access, { aoiId: searchParam(req, "aoi") }) }));

/** Create a reference layer from a validated upload. Body: { uploadId, name, kind, aoiId? } */
export const POST = orgApi("layers.manage", async (req, { access }) => ok(await importUploadAsLayer(access, (await readJson(req)) as never), { status: 201 }));
