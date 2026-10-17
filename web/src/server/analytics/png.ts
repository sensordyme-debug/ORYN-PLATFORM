/**
 * Dependency-free PNG encoder for 8-bit RGBA images.
 *
 * Output: signature, IHDR (bit depth 8, colour type 6 = RGBA, no interlace),
 * one IDAT (zlib deflate via node:zlib), IEND. CRC-32 per chunk via
 * node:zlib.crc32. Scanline filtering is adaptive by default: each row uses
 * whichever of the five PNG filters (None, Sub, Up, Average, Paeth) gives the
 * smallest sum of absolute signed bytes — the heuristic recommended by the
 * PNG specification. `filter: "none"` writes filter type 0 for every row.
 */
import { crc32, deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BPP = 4;

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBytes.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(data, crc32(typeBytes)) >>> 0, 8 + data.length);
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Write row `y` filtered with `type` into dst (stride bytes). Returns the sum of |signed byte|. */
function filterRow(type: number, rgba: Uint8Array, y: number, stride: number, dst: Uint8Array): number {
  const cur = y * stride;
  const prev = (y - 1) * stride;
  const hasPrev = y > 0;
  let cost = 0;
  for (let i = 0; i < stride; i++) {
    const x = rgba[cur + i]!;
    const a = i >= BPP ? rgba[cur + i - BPP]! : 0;
    const b = hasPrev ? rgba[prev + i]! : 0;
    const c = hasPrev && i >= BPP ? rgba[prev + i - BPP]! : 0;
    let pred = 0;
    if (type === 1) pred = a;
    else if (type === 2) pred = b;
    else if (type === 3) pred = (a + b) >> 1;
    else if (type === 4) pred = paeth(a, b, c);
    const v = (x - pred) & 0xff;
    dst[i] = v;
    cost += v < 128 ? v : 256 - v;
  }
  return cost;
}

export function encodePng(rgba: Uint8Array, width: number, height: number, opts: { filter?: "adaptive" | "none"; level?: number } = {}): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`PNG dimensions must be positive integers (got ${width} × ${height}).`);
  }
  if (rgba.length !== width * height * BPP) throw new RangeError("RGBA buffer length must equal width × height × 4.");
  const stride = width * BPP;
  const raw = Buffer.alloc(height * (stride + 1));
  const scratch = new Uint8Array(stride);
  const best = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    if (opts.filter === "none") {
      raw[rowStart] = 0;
      raw.set(rgba.subarray(y * stride, (y + 1) * stride), rowStart + 1);
      continue;
    }
    let bestType = 0;
    let bestCost = filterRow(0, rgba, y, stride, best);
    for (let t = 1; t <= 4; t++) {
      const cost = filterRow(t, rgba, y, stride, scratch);
      if (cost < bestCost) {
        bestCost = cost;
        bestType = t;
        best.set(scratch);
      }
    }
    raw[rowStart] = bestType;
    raw.set(best, rowStart + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method 0
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: opts.level ?? 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
