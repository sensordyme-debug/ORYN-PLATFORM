import { orgApi } from "@/server/authz/next";
import { env } from "@/server/config/env";
import { DomainError } from "@/server/errors";
import { ok } from "@/server/http";
import { receiveUpload } from "@/server/uploads/service";

export const runtime = "nodejs";

/** multipart/form-data with a single "file" field (GeoJSON). */
export const POST = orgApi(
  "uploads.create",
  async (req, { access }) => {
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > env.maxUploadBytes() + 64 * 1024) throw new DomainError("too_large", "The file is too large.", 422);
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new DomainError("invalid", "Attach a GeoJSON file in the “file” field.", 422);
    const result = await receiveUpload(access, { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
    return ok(result, { status: result.status === "validated" ? 201 : 422 });
  },
  { rateLimit: { limit: 20, windowMs: 60_000 } },
);
