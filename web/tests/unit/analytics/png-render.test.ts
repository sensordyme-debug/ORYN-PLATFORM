import { crc32, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodePng } from "@/server/analytics/png";
import {
  LEGEND_MASKED_VALUE,
  MASKED_RGBA,
  NDVI_STOPS,
  colorRamp,
  renderContinuous,
  renderLandcover,
  renderTrueColor,
  renderWaterMask,
} from "@/server/analytics/render";
import { WORLDCOVER_TABLE } from "@/server/analytics/landcover";

type Chunk = { type: string; data: Buffer; crcOk: boolean };

function parsePng(png: Buffer): Chunk[] {
  expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks: Chunk[] = [];
  let o = 8;
  while (o < png.length) {
    const len = png.readUInt32BE(o);
    const type = png.subarray(o + 4, o + 8).toString("ascii");
    const data = png.subarray(o + 8, o + 8 + len);
    const crc = png.readUInt32BE(o + 8 + len);
    chunks.push({ type, data, crcOk: crc32(png.subarray(o + 4, o + 8 + len)) >>> 0 === crc });
    o += 12 + len;
  }
  return chunks;
}

/** Decode a non-interlaced 8-bit RGBA PNG back to raw pixels (reverses all five filters). */
function decodeRgba(png: Buffer): { width: number; height: number; rgba: Uint8Array; filters: number[] } {
  const chunks = parsePng(png);
  const ihdr = chunks[0]!.data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)));
  const stride = width * 4;
  expect(raw.length).toBe(height * (stride + 1));
  const out = new Uint8Array(height * stride);
  const filters: number[] = [];
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    filters.push(f);
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i]!;
      const a = i >= 4 ? out[y * stride + i - 4]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + i]! : 0;
      const c = y > 0 && i >= 4 ? out[(y - 1) * stride + i - 4]! : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + i] = (x + pred) & 0xff;
    }
  }
  return { width, height, rgba: out, filters };
}

function testImage(w: number, h: number): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      rgba[o] = (x * 37) & 255;
      rgba[o + 1] = (y * 11 + x) & 255;
      rgba[o + 2] = (x * y) & 255;
      rgba[o + 3] = x % 7 === 0 ? 0 : 255;
    }
  }
  return rgba;
}

describe("encodePng", () => {
  it("writes a valid signature, IHDR, CRCs and IEND", () => {
    const png = encodePng(testImage(13, 7), 13, 7);
    const chunks = parsePng(png);
    expect(chunks.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(chunks.every((c) => c.crcOk)).toBe(true);
    const ihdr = chunks[0]!.data;
    expect(ihdr.length).toBe(13);
    expect(ihdr.readUInt32BE(0)).toBe(13);
    expect(ihdr.readUInt32BE(4)).toBe(7);
    expect(Array.from(ihdr.subarray(8))).toEqual([8, 6, 0, 0, 0]);
    expect(chunks[2]!.data.length).toBe(0);
  });

  it("IDAT inflates to scanlines that reproduce the input (adaptive filters)", () => {
    const img = testImage(64, 40);
    const decoded = decodeRgba(encodePng(img, 64, 40));
    expect(decoded.width).toBe(64);
    expect(decoded.height).toBe(40);
    expect(Buffer.from(decoded.rgba).equals(Buffer.from(img))).toBe(true);
    expect(decoded.filters.every((f) => f >= 0 && f <= 4)).toBe(true);
    expect(new Set(decoded.filters).size).toBeGreaterThan(1);
  });

  it("supports filter type 0 only", () => {
    const img = testImage(5, 5);
    const decoded = decodeRgba(encodePng(img, 5, 5, { filter: "none" }));
    expect(decoded.filters).toEqual([0, 0, 0, 0, 0]);
    expect(Buffer.from(decoded.rgba).equals(Buffer.from(img))).toBe(true);
  });

  it("rejects inconsistent buffers", () => {
    expect(() => encodePng(new Uint8Array(10), 2, 2)).toThrow(RangeError);
  });
});

describe("render", () => {
  const px = (rgba: Uint8Array, i: number) => Array.from(rgba.subarray(i * 4, i * 4 + 4));

  it("ramps NDVI through the documented stops and clamps the ends", () => {
    const ramp = colorRamp(NDVI_STOPS);
    expect(ramp(-1)).toEqual([0x8c, 0x51, 0x0a, 255]);
    expect(ramp(0.9)).toEqual([0x00, 0x68, 0x37, 255]);
    expect(ramp(5)).toEqual([0x00, 0x68, 0x37, 255]);
  });

  it("makes outside-AOI transparent and masked pixels grey, with a legend entry", () => {
    const values = Float32Array.from([0.9, Number.NaN, 0.5, -0.2]);
    const inside = Uint8Array.from([1, 1, 1, 0]);
    const { png, legend } = renderContinuous(values, 2, 2, inside, "ndvi");
    const { rgba } = decodeRgba(png);
    expect(px(rgba, 0)).toEqual([0x00, 0x68, 0x37, 255]);
    expect(px(rgba, 1)).toEqual(MASKED_RGBA);
    expect(px(rgba, 2)[3]).toBe(255);
    expect(px(rgba, 3)).toEqual([0, 0, 0, 0]);
    expect(legend).toMatchObject({ kind: "ndvi", min: -0.2, max: 0.9 });
    expect(legend.stops!.at(-1)!.value).toBe(LEGEND_MASKED_VALUE);
    expect(legend.stops!.at(-1)!.label).toMatch(/Masked/);
  });

  it("renders water masks, land cover and true colour", () => {
    const inside = Uint8Array.from([1, 1, 1, 0]);
    const water = renderWaterMask(Uint8Array.from([1, 0, 0, 1]), Uint8Array.from([1, 1, 0, 1]), 2, 2, inside);
    const w = decodeRgba(water.png).rgba;
    expect(px(w, 0)).toEqual([0x1f, 0x78, 0xb4, 255]);
    expect(px(w, 2)).toEqual(MASKED_RGBA);
    expect(px(w, 3)[3]).toBe(0);
    expect(water.legend.kind).toBe("water_mask");

    const lc = renderLandcover(Uint8Array.from([10, 80, 0, 10]), Uint8Array.from([1, 1, 0, 0]), 2, 2, inside, WORLDCOVER_TABLE);
    const l = decodeRgba(lc.png).rgba;
    expect(px(l, 0)).toEqual([0x00, 0x64, 0x00, 255]);
    expect(px(l, 1)).toEqual([0x00, 0x64, 0xc8, 255]);
    expect(px(l, 2)).toEqual(MASKED_RGBA);
    expect(lc.legend.stops!.map((s) => s.label)).toEqual(["Tree cover", "Permanent water bodies", expect.stringMatching(/No land-cover/)]);

    const tc = renderTrueColor(
      [Uint8Array.from([200, 0, 5, 9]), Uint8Array.from([100, 0, 5, 9]), Uint8Array.from([50, 0, 5, 9])],
      2,
      2,
      inside,
      Uint8Array.from([1, 0, 1, 0]),
      { mode: "direct8bit" },
    );
    const t = decodeRgba(tc.png).rgba;
    expect(px(t, 0)).toEqual([200, 100, 50, 255]);
    expect(px(t, 1)).toEqual(MASKED_RGBA);
    expect(tc.legend.kind).toBe("true_color");
  });

  it("stretches reflectance jointly between the 2nd and 98th percentiles", () => {
    const n = 100;
    const band = Uint16Array.from({ length: n }, (_, i) => 1000 + i * 10);
    const s = { scale: 0.0001, offset: -0.1, nodata: 0 };
    const all = new Uint8Array(n).fill(1);
    const tc = renderTrueColor([band, band, band], 10, 10, all, all, { mode: "stretch", scaling: [s, s, s] });
    expect(tc.legend.min).toBeGreaterThan(0);
    expect(tc.legend.max!).toBeGreaterThan(tc.legend.min!);
    const rgba = decodeRgba(tc.png).rgba;
    expect(px(rgba, 0)).toEqual([0, 0, 0, 255]);
    expect(px(rgba, n - 1)).toEqual([255, 255, 255, 255]);
  });
});
