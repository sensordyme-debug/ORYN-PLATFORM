/**
 * Object storage for derived rasters, reports, exports, and uploads.
 *
 * Keys are always tenant-prefixed ("orgs/<org-id>/…") by the callers that
 * create them, and every read path re-derives the key from a database row
 * the caller was authorized to see — keys are never taken from user input.
 *
 * Drivers
 *   local  files under ORYN_STORAGE_DIR (development; production refuses it
 *          unless ORYN_ALLOW_LOCAL_STORAGE_IN_PRODUCTION is set — see preflight)
 *   s3     an S3-compatible service via SigV4 (aws4fetch). Objects are written
 *          with server-side encryption (SSE-S3) unless ORYN_S3_SSE=none. The
 *          bucket must be private: the app never issues public or presigned
 *          URLs — every download is streamed through an authorized route.
 *          Verified by tests/integration/storage-s3.test.ts against a local
 *          S3-compatible server (SeaweedFS); each provider (AWS S3, R2, …)
 *          still needs `npm run oryn:verify -- storage` in its deployment.
 */
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AwsClient } from "aws4fetch";
import { env } from "@/server/config/env";

const KEY_RE = /^[a-z0-9][a-z0-9/_.-]{0,511}$/i;

export function assertKey(key: string): string {
  if (!KEY_RE.test(key) || key.includes("..") || key.includes("//")) {
    throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
  }
  return key;
}

export type StoredObject = { body: Buffer; contentType: string | null; size: number };

export interface ObjectStorage {
  put(key: string, body: Buffer | Uint8Array, contentType: string): Promise<{ size: number }>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}

class LocalStorage implements ObjectStorage {
  constructor(private readonly root: string) {}

  private resolve(key: string) {
    const full = path.resolve(this.root, assertKey(key));
    const root = path.resolve(this.root);
    if (!full.startsWith(root + path.sep)) throw new Error("Storage key escapes storage root");
    return full;
  }

  async put(key: string, body: Buffer | Uint8Array, contentType: string) {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
    await writeFile(`${file}.meta.json`, JSON.stringify({ contentType }));
    return { size: body.byteLength };
  }

  async get(key: string): Promise<StoredObject | null> {
    const file = this.resolve(key);
    try {
      const [body, meta] = await Promise.all([readFile(file), readFile(`${file}.meta.json`, "utf8").catch(() => "{}")]);
      const parsed = JSON.parse(meta) as { contentType?: string };
      return { body, contentType: parsed.contentType ?? null, size: (await stat(file)).size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async delete(key: string) {
    const file = this.resolve(key);
    await rm(file, { force: true });
    await rm(`${file}.meta.json`, { force: true });
  }
}

export type S3Config = ReturnType<typeof env.s3>;

/** Base URL of the bucket (path-style when an endpoint is configured or forced). */
export function s3BucketUrl(cfg: Pick<S3Config, "bucket" | "region" | "endpoint" | "forcePathStyle">): string {
  const endpoint = (cfg.endpoint ?? `https://s3.${cfg.region}.amazonaws.com`).replace(/\/$/, "");
  return cfg.forcePathStyle || cfg.endpoint ? `${endpoint}/${cfg.bucket}` : `https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com`;
}

export function s3ObjectUrl(bucketUrl: string, key: string): string {
  return `${bucketUrl}/${assertKey(key).split("/").map(encodeURIComponent).join("/")}`;
}

class S3Storage implements ObjectStorage {
  private readonly client: AwsClient;
  private readonly base: string;
  private readonly sse: "AES256" | "none";

  constructor(cfg: S3Config) {
    this.sse = cfg.sse;
    this.client = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, region: cfg.region, service: "s3" });
    this.base = s3BucketUrl(cfg);
  }

  private url(key: string) {
    return s3ObjectUrl(this.base, key);
  }

  async put(key: string, body: Buffer | Uint8Array, contentType: string) {
    const bytes = Buffer.from(body);
    const headers = { "Content-Type": contentType, ...(this.sse === "none" ? {} : { "x-amz-server-side-encryption": this.sse }) };
    // Sign, then send the bytes ourselves. aws4fetch's own fetch() passes a
    // Request object, which Next.js's patched fetch re-wraps as a stream: the
    // upload then goes out chunked without Content-Length, and S3 services
    // such as Railway Buckets refuse it (411 MissingContentLength). Retries
    // 5xx/429 like aws4fetch does.
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      const signed = await this.client.sign(this.url(key), { method: "PUT", body: bytes, headers });
      res = await fetch(signed.url, { method: "PUT", headers: signed.headers, body: bytes });
      if ((res.status < 500 && res.status !== 429) || attempt >= 2) break;
      await res.body?.cancel().catch(() => {});
      await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
    }
    if (!res.ok) throw new Error(`Object storage PUT failed: ${res.status}${await s3ErrorCode(res)}`);
    return { size: bytes.byteLength };
  }

  async get(key: string): Promise<StoredObject | null> {
    const res = await this.client.fetch(this.url(key));
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (!res.ok) throw new Error(`Object storage GET failed: ${res.status}${await s3ErrorCode(res)}`);
    const body = Buffer.from(await res.arrayBuffer());
    return { body, contentType: res.headers.get("content-type"), size: body.byteLength };
  }

  async delete(key: string) {
    const res = await this.client.fetch(this.url(key), { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error(`Object storage DELETE failed: ${res.status}${await s3ErrorCode(res)}`);
  }
}

/** The S3 error code from an error response body (never the message, which can echo request details). */
async function s3ErrorCode(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  const code = /<Code>([A-Za-z]{1,64})<\/Code>/.exec(text)?.[1];
  return code ? ` (${code})` : "";
}

/** Build a driver from explicit configuration (tests, the verify CLI). */
export function createStorage(cfg: { driver: "local"; dir: string } | ({ driver: "s3" } & S3Config)): ObjectStorage {
  return cfg.driver === "s3" ? new S3Storage(cfg) : new LocalStorage(cfg.dir);
}

let instance: ObjectStorage | null = null;

export function storage(): ObjectStorage {
  if (!instance) {
    instance =
      env.storageDriver() === "s3"
        ? new S3Storage(env.s3())
        : // Runtime data directory — excluded from build-time file tracing.
          new LocalStorage(path.resolve(/* turbopackIgnore: true */ process.cwd(), env.storageDir()));
  }
  return instance;
}

/** For tests. */
export function setStorageForTesting(s: ObjectStorage | null) {
  instance = s;
  lastProbe = null;
}

let lastProbe: { at: number; ok: boolean } | null = null;

/**
 * Readiness: write, read back, and delete a small object (cached for 60 s).
 * Proves credentials, bucket, and encryption settings work — not just that
 * configuration is present. Errors are logged by the caller, never returned
 * to clients.
 */
export async function probeStorage(s: ObjectStorage = storage(), now = Date.now()): Promise<boolean> {
  if (lastProbe && now - lastProbe.at < 60_000) return lastProbe.ok;
  const key = `health/probe-${process.pid}`;
  const body = Buffer.from(`oryn-storage-probe ${now}`);
  try {
    await s.put(key, body, "text/plain");
    const back = await s.get(key);
    await s.delete(key);
    const ok = Boolean(back && Buffer.compare(back.body, body) === 0);
    lastProbe = { at: now, ok };
    return ok;
  } catch (err) {
    lastProbe = { at: now, ok: false };
    throw err;
  }
}

export function orgKey(orgId: string, ...parts: string[]): string {
  return assertKey(["orgs", orgId, ...parts].join("/"));
}
