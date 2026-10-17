/**
 * S3 uploads must carry Content-Length. Railway Buckets (like several S3
 * services) refuse a chunked PUT with 411 MissingContentLength. Inside
 * Next.js, the patched global fetch re-wraps a Request object's body as a
 * stream, so passing aws4fetch's signed Request to fetch lost the length;
 * plain Node kept it, which is why only the web service failed.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createStorage } from "@/server/storage";

let server: http.Server;
let endpoint = "";
const seen: { contentLength?: string; transferEncoding?: string; auth?: string }[] = [];
const objects = new Map<string, Buffer>();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c)).on("end", () => {
      if (req.method === "PUT") {
        seen.push({ contentLength: req.headers["content-length"], transferEncoding: req.headers["transfer-encoding"], auth: req.headers.authorization });
        if (req.headers["content-length"] === undefined) {
          res.writeHead(411, { "content-type": "application/xml" }).end("<Error><Code>MissingContentLength</Code></Error>");
          return;
        }
        objects.set(req.url!, Buffer.concat(chunks));
        res.writeHead(200).end();
        return;
      }
      const body = objects.get(req.url!);
      if (req.method === "GET" && body) res.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
      else res.writeHead(req.method === "DELETE" ? 204 : 404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
afterEach(() => {
  vi.unstubAllGlobals();
  seen.length = 0;
});

const s3 = () =>
  createStorage({ driver: "s3", bucket: "b", region: "auto", endpoint, accessKeyId: "test-key", secretAccessKey: "test-secret", forcePathStyle: false, sse: "none" });

/** What Next.js's patched fetch does to a Request with a body: re-wraps it as a stream (no length). */
function nextLikeFetch() {
  const original = globalThis.fetch;
  return (input: RequestInfo | URL, init?: RequestInit) =>
    input instanceof Request && input.body
      ? original(new Request(input.url, { method: input.method, headers: input.headers, body: input.body, duplex: "half" } as RequestInit))
      : original(input, init);
}

describe("S3 uploads", () => {
  it("send Content-Length and a SigV4 signature, and round-trip the bytes", async () => {
    const body = Buffer.from("oryn-storage-probe");
    await s3().put("org/x/probe.txt", body, "text/plain");
    expect(seen).toEqual([{ contentLength: String(body.byteLength), transferEncoding: undefined, auth: expect.stringMatching(/^AWS4-HMAC-SHA256 /) }]);
    expect((await s3().get("org/x/probe.txt"))?.body.equals(body)).toBe(true);
  });

  it("still send Content-Length when fetch re-wraps Request bodies as streams (Next.js)", async () => {
    vi.stubGlobal("fetch", nextLikeFetch());
    await expect(s3().put("org/x/next.txt", Buffer.from("from the web service"), "text/plain")).resolves.toEqual({ size: 20 });
    expect(seen[0]).toMatchObject({ contentLength: "20", transferEncoding: undefined });
  });
});
