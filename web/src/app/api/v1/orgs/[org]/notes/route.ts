import { z } from "zod";
import { orgApi } from "@/server/authz/next";
import { ok, readJson, searchParam } from "@/server/http";
import { addNote, listNotes, NOTE_TARGETS } from "@/server/results/service";

export const runtime = "nodejs";

const target = z.enum(NOTE_TARGETS);

export const GET = orgApi("results.read", async (req, { access }) =>
  ok({ items: await listNotes(access, target.parse(searchParam(req, "targetType")), searchParam(req, "targetId") ?? "") }),
);

export const POST = orgApi("notes.write", async (req, { access }) => {
  const body = z.object({ targetType: target, targetId: z.string(), body: z.string() }).parse(await readJson(req));
  const id = await addNote(access, body.targetType, body.targetId, body.body);
  return ok({ id }, { status: 201 });
});
