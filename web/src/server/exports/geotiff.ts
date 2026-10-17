/**
 * Minimal single-band Float32 GeoTIFF writer.
 *
 * Writes a baseline little-endian TIFF (one uncompressed strip, BlackIsZero,
 * SampleFormat IEEE float) with the GeoTIFF 1.0 tags:
 *   ModelPixelScaleTag (33550)  [pixelWidth, pixelHeight, 0]
 *   ModelTiepointTag   (33922)  raster (0,0) → model (originX, originY)
 *   GeoKeyDirectoryTag (34735)  GTModelTypeGeoKey, GTRasterTypeGeoKey
 *                               (RasterPixelIsArea), and ProjectedCSTypeGeoKey
 *                               or GeographicTypeGeoKey = EPSG code
 *   GDAL_NODATA        (42113)  "nan"
 *
 * Guarantees
 *  - The georeferencing matches a GDAL-style north-up affine transform
 *    exactly (pixel-is-area: the tiepoint is the outer corner of pixel 0,0).
 *  - Rotated / sheared or south-up transforms are rejected rather than
 *    written incorrectly (they would need ModelTransformationTag).
 */

export type GeoTransform = [number, number, number, number, number, number];

export type GeoTiffInput = {
  width: number;
  height: number;
  /** Row-major values, NaN = no data. */
  data: Float32Array;
  /** GDAL-style [originX, pixelW, 0, originY, 0, -pixelH] in the raster CRS. */
  transform: GeoTransform;
  epsg: number;
  /** Override geographic/projected detection for the EPSG code. */
  geographic?: boolean;
};

export const GEOTIFF_CONTENT_TYPE = "image/tiff; application=geotiff";

/** Geographic 2D CRSs ORYN may encounter; anything else is treated as projected. */
const GEOGRAPHIC_EPSG = new Set([4326, 4269, 4258, 4283, 4167, 4617, 4674, 4612, 4148, 4152, 6318, 7844, 9000]);

export function isGeographicEpsg(epsg: number): boolean {
  return GEOGRAPHIC_EPSG.has(epsg);
}

/** TIFF field types used here. */
const T = { ASCII: 2, SHORT: 3, LONG: 4, DOUBLE: 12 } as const;
type T = (typeof T)[keyof typeof T];

const TYPE_SIZE: Record<T, number> = { [T.ASCII]: 1, [T.SHORT]: 2, [T.LONG]: 4, [T.DOUBLE]: 8 };

type Entry = { tag: number; type: T; values: number[] | string };

/** Copy little-endian Float32 bytes (e.g. from storage) into a Float32Array. */
export function float32FromLittleEndian(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 4 !== 0) throw new Error("Float32 raster byte length is not a multiple of 4.");
  const out = new Float32Array(bytes.byteLength / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

export function writeFloat32GeoTiff(input: GeoTiffInput): Buffer {
  const { width, height, data, transform, epsg } = input;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error("Raster dimensions must be positive integers.");
  if (data.length !== width * height) throw new Error(`Raster has ${data.length} values; expected ${width * height}.`);
  if (!Number.isInteger(epsg) || epsg < 1 || epsg > 65535) throw new Error(`EPSG code ${epsg} cannot be encoded in a GeoKey.`);
  const [originX, pixelW, rotX, originY, rotY, pixelHNeg] = transform;
  if (rotX !== 0 || rotY !== 0) throw new Error("Rotated or sheared rasters are not supported.");
  if (!(pixelW > 0) || !(pixelHNeg < 0)) throw new Error("Only north-up rasters (positive pixel width, negative pixel height) are supported.");
  if (![originX, pixelW, originY, pixelHNeg].every(Number.isFinite)) throw new Error("Raster transform must be finite.");

  const geographic = input.geographic ?? isGeographicEpsg(epsg);
  const imageBytes = width * height * 4;
  const geoKeys = [
    1, 1, 0, 3, // KeyDirectoryVersion, KeyRevision, MinorRevision, NumberOfKeys
    1024, 0, 1, geographic ? 2 : 1, // GTModelTypeGeoKey: 1 projected, 2 geographic
    1025, 0, 1, 1, // GTRasterTypeGeoKey: RasterPixelIsArea
    geographic ? 2048 : 3072, 0, 1, epsg, // GeographicTypeGeoKey | ProjectedCSTypeGeoKey
  ];

  // Strip offset is patched once the layout is known.
  const entries: Entry[] = [
    { tag: 256, type: T.LONG, values: [width] }, // ImageWidth
    { tag: 257, type: T.LONG, values: [height] }, // ImageLength
    { tag: 258, type: T.SHORT, values: [32] }, // BitsPerSample
    { tag: 259, type: T.SHORT, values: [1] }, // Compression: none
    { tag: 262, type: T.SHORT, values: [1] }, // PhotometricInterpretation: BlackIsZero
    { tag: 273, type: T.LONG, values: [0] }, // StripOffsets
    { tag: 277, type: T.SHORT, values: [1] }, // SamplesPerPixel
    { tag: 278, type: T.LONG, values: [height] }, // RowsPerStrip
    { tag: 279, type: T.LONG, values: [imageBytes] }, // StripByteCounts
    { tag: 284, type: T.SHORT, values: [1] }, // PlanarConfiguration: chunky
    { tag: 339, type: T.SHORT, values: [3] }, // SampleFormat: IEEE floating point
    { tag: 33550, type: T.DOUBLE, values: [pixelW, -pixelHNeg, 0] }, // ModelPixelScaleTag
    { tag: 33922, type: T.DOUBLE, values: [0, 0, 0, originX, originY, 0] }, // ModelTiepointTag
    { tag: 34735, type: T.SHORT, values: geoKeys }, // GeoKeyDirectoryTag
    { tag: 42113, type: T.ASCII, values: "nan\0" }, // GDAL_NODATA
  ];

  const count = (e: Entry) => (typeof e.values === "string" ? e.values.length : e.values.length);
  const size = (e: Entry) => count(e) * TYPE_SIZE[e.type];
  const align = (n: number, a: number) => Math.ceil(n / a) * a;

  const ifdOffset = 8;
  const ifdSize = 2 + entries.length * 12 + 4;
  let cursor = ifdOffset + ifdSize;
  const valueOffsets = new Map<number, number>();
  for (const e of entries) {
    if (size(e) > 4) {
      cursor = align(cursor, 8);
      valueOffsets.set(e.tag, cursor);
      cursor += size(e);
    }
  }
  const stripOffset = align(cursor, 8);
  (entries.find((e) => e.tag === 273)!.values as number[])[0] = stripOffset;

  const buf = Buffer.alloc(stripOffset + imageBytes);
  buf.write("II", 0, "latin1");
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(ifdOffset, 4);
  buf.writeUInt16LE(entries.length, ifdOffset);

  const writeValues = (e: Entry, at: number) => {
    if (typeof e.values === "string") {
      buf.write(e.values, at, "latin1");
      return;
    }
    e.values.forEach((v, i) => {
      if (e.type === T.SHORT) buf.writeUInt16LE(v, at + i * 2);
      else if (e.type === T.LONG) buf.writeUInt32LE(v, at + i * 4);
      else buf.writeDoubleLE(v, at + i * 8);
    });
  };

  entries.forEach((e, i) => {
    const at = ifdOffset + 2 + i * 12;
    buf.writeUInt16LE(e.tag, at);
    buf.writeUInt16LE(e.type, at + 2);
    buf.writeUInt32LE(count(e), at + 4);
    const off = valueOffsets.get(e.tag);
    if (off === undefined) writeValues(e, at + 8);
    else {
      buf.writeUInt32LE(off, at + 8);
      writeValues(e, off);
    }
  });
  buf.writeUInt32LE(0, ifdOffset + 2 + entries.length * 12); // no next IFD

  for (let i = 0; i < data.length; i++) buf.writeFloatLE(data[i]!, stripOffset + i * 4);
  return buf;
}
