/**
 * COG reader against a local HTTP server with Range support (no external network).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { writeArrayBuffer } from "geotiff";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AssetReadError,
  CrsMismatchError,
  InvalidRasterError,
  RasterTooLargeError,
  UnsupportedCrsError,
  isRetryable,
} from "@/server/analytics/errors";
import { clearCogCache, openCog, readToGrid } from "@/server/analytics/raster/cog";
import type { Grid } from "@/server/analytics/raster/grid";

function tiff(epsg: number, opts: { width?: number; height?: number } = {}): Buffer {
  const width = opts.width ?? 6;
  const height = opts.height ?? 4;
  const data = new Uint16Array(width * height).map((_, i) => i + 1);
  return Buffer.from(
    writeArrayBuffer(data, {
      width,
      height,
      BitsPerSample: [16],
      SampleFormat: [1],
      SamplesPerPixel: 1,
      ModelPixelScale: [10, 10, 0],
      ModelTiepoint: [0, 0, 0, 199_980, 4_000_020, 0],
      GTModelTypeGeoKey: 1,
      GTRasterTypeGeoKey: 1,
      ProjectedCSTypeGeoKey: epsg,
      GDAL_NODATA: "0",
    }),
  );
}

const files: Record<string, Buffer> = {
  "/b04.tif": tiff(32618),
  "/utm17.tif": tiff(32617),
  "/user-defined.tif": tiff(32767),
  "/garbage.tif": Buffer.from("this is not a tiff file at all, just some bytes padding padding padding"),
};
const hits: Record<string, number> = {};
let server: Server;
let base = "";

function serveRange(req: IncomingMessage, res: ServerResponse, body: Buffer) {
  const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
  if (!m) {
    res.writeHead(200, { "content-length": body.length });
    res.end(body);
    return;
  }
  const start = Number(m[1]);
  const end = Math.min(Number(m[2]), body.length - 1);
  res.writeHead(206, {
    "content-range": `bytes ${start}-${end}/${body.length}`,
    "content-length": end - start + 1,
    "content-type": "image/tiff",
  });
  res.end(body.subarray(start, end + 1));
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0]!;
    hits[path] = (hits[path] ?? 0) + 1;
    if (path === "/missing.tif") return void res.writeHead(404).end();
    if (path === "/busy.tif") return void res.writeHead(503).end();
    if (path === "/no-range.tif") {
      res.writeHead(200, { "content-length": files["/b04.tif"]!.length });
      return void res.end(files["/b04.tif"]);
    }
    if (path === "/private.tif") {
      if (req.headers["x-oryn-key"] !== "k1") return void res.writeHead(403).end();
      return serveRange(req, res, files["/b04.tif"]!);
    }
    const body = files[path];
    if (!body) return void res.writeHead(404).end();
    serveRange(req, res, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => clearCogCache());

const GRID: Grid = { width: 2, height: 2, epsg: 32618, transform: [199_990, 10, 0, 4_000_010, 0, -10] };

describe("COG reader", () => {
  it("reads CRS and lattice from GeoKeys and reads a window onto the grid", async () => {
    const src = await openCog({ url: `${base}/b04.tif` });
    expect(src.info).toMatchObject({ epsg: 32618, originX: 199_980, originY: 4_000_020, nodata: 0, dataType: "uint16", samplesPerPixel: 1 });
    expect(src.info.levels[0]).toEqual({ width: 6, height: 4, pixelW: 10, pixelH: 10 });
    const read = await readToGrid({ url: `${base}/b04.tif` }, GRID);
    // Pixel (col 1, row 1) holds 1 + 1·6 + 1 = 8.
    expect(Array.from(read.values)).toEqual([8, 9, 14, 15]);
    expect(Array.from(read.footprint)).toEqual([1, 1, 1, 1]);
  });

  it("caches opened files", async () => {
    await openCog({ url: `${base}/b04.tif?v=cache` });
    const before = hits["/b04.tif"]!;
    await openCog({ url: `${base}/b04.tif?v=cache` });
    expect(hits["/b04.tif"]).toBe(before);
  });

  it("forwards access headers", async () => {
    await expect(openCog({ url: `${base}/private.tif` })).rejects.toMatchObject({ status: 403, retryable: true });
    const src = await openCog({ url: `${base}/private.tif`, headers: { "x-oryn-key": "k1" } });
    expect(src.info.epsg).toBe(32618);
  });

  it("maps HTTP failures to AssetReadError with a redacted URL", async () => {
    const err = await openCog({ url: `${base}/missing.tif?sig=SECRET123` }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AssetReadError);
    expect((err as AssetReadError).status).toBe(404);
    expect(isRetryable(err)).toBe(false);
    expect((err as Error).message).not.toContain("SECRET123");

    const busy = await openCog({ url: `${base}/busy.tif` }).catch((e: unknown) => e);
    expect(busy).toBeInstanceOf(AssetReadError);
    expect(isRetryable(busy)).toBe(true);

    const refused = await openCog({ url: "http://127.0.0.1:1/nothing.tif" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AssetReadError);
    expect(isRetryable(refused)).toBe(true);

    const noRange = await openCog({ url: `${base}/no-range.tif` }).catch((e: unknown) => e);
    expect(noRange).toBeInstanceOf(AssetReadError);
    expect(isRetryable(noRange)).toBe(false);
  });

  it("rejects CRS mismatches, user-defined CRSs and undecodable files permanently", async () => {
    await expect(readToGrid({ url: `${base}/utm17.tif` }, GRID)).rejects.toThrow(CrsMismatchError);
    await expect(openCog({ url: `${base}/user-defined.tif` })).rejects.toThrow(UnsupportedCrsError);
    const garbage = await openCog({ url: `${base}/garbage.tif` }).catch((e: unknown) => e);
    expect(garbage).toBeInstanceOf(InvalidRasterError);
    expect(isRetryable(garbage)).toBe(false);
  });

  it("enforces the pixel budget and honours aborts", async () => {
    const huge: Grid = { width: 10_000, height: 10_000, epsg: 32618, transform: [199_980, 10, 0, 4_000_020, 0, -10] };
    await expect(readToGrid({ url: `${base}/b04.tif` }, huge, { maxPixels: 25_000_000 })).rejects.toThrow(RasterTooLargeError);
    const ac = new AbortController();
    ac.abort();
    await expect(readToGrid({ url: `${base}/b04.tif` }, GRID, { signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
