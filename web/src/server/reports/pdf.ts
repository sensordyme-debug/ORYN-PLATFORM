/**
 * Report PDF rendering (pdfkit, built-in Helvetica only — no external fonts).
 *
 * Renders exclusively from the frozen ReportContent snapshot (plus the
 * stored PNG preview of the latest observation, when one exists), so a PDF
 * can always be regenerated identically from reports.content.
 *
 * Guarantees
 *  - The title block states the data currency (e.g. "Latest usable imagery
 *    is 23 days old") and synthetic-data notices.
 *  - Every table row carries its evidence id; the evidence index at the end
 *    maps ids to source tables and rows.
 *  - Text is reduced to the WinAnsi character set the standard PDF fonts
 *    can encode (≥ → ">=", − → "-", …), so nothing renders as garbage.
 */
import PDFDocument from "pdfkit";
import { formatArea } from "@/lib/geo";
import { MAX_FINDING_PAGES } from "@/server/reports/comparison";
import { REPORT_TYPE_LABEL, type ComparisonSection, type DataStatus, type ReportContent } from "@/server/reports/types";

type Doc = PDFKit.PDFDocument;
type Col = { header: string; width: number; align?: "left" | "right" };

const MARGIN = 50;
const COLORS = { text: "#111827", muted: "#4b5563", rule: "#d1d5db", head: "#eef2f7", accent: "#1d4ed8", aoi: "#d9480f" };
const STATUS_COLOR: Record<DataStatus, string> = { ok: "#166534", partial: "#92400e", stale: "#b45309", missing: "#b91c1c" };

// ── Text safety ────────────────────────────────────────────────

const REPLACEMENTS: Record<string, string> = {
  "≥": ">=",
  "≤": "<=",
  "−": "-",
  "→": "->",
  "←": "<-",
  "↑": "^",
  "≈": "~",
  "Δ": "delta ",
  "′": "'",
  "″": '"',
  " ": " ",
};
// Characters outside Latin-1 that WinAnsi (the standard 14 fonts' encoding) can still represent.
const WINANSI_EXTRA = new Set("\u20ac\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u017d\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u017e\u0178".split(""));

export function pdfSafe(input: unknown): string {
  const s = input == null ? "" : String(input);
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (REPLACEMENTS[ch] !== undefined) out += REPLACEMENTS[ch];
    else if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || ch === "\n" || WINANSI_EXTRA.has(ch)) out += ch;
    else if (ch === "\t" || ch === "\r") out += " ";
    else out += "?";
  }
  return out;
}

const clip = (s: string, n = 500) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const d10 = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "-");
const dt = (iso: string | null | undefined) => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "-");
const n = (v: number | null | undefined, digits = 3) => (typeof v === "number" && Number.isFinite(v) ? String(Math.round(v * 10 ** digits) / 10 ** digits) : "-");
/** One decimal, so 99.8% is not shown as 100%. */
const pct1 = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? `${(Math.round(v * 1000) / 10).toFixed(1)}%` : "-");
const pctOf = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? `${Math.round(v * 100)}%` : "-");

// ── Layout helpers ─────────────────────────────────────────────

function contentWidth(doc: Doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function bottom(doc: Doc) {
  return doc.page.height - doc.page.margins.bottom;
}

function ensure(doc: Doc, h: number) {
  if (doc.y + h > bottom(doc)) doc.addPage();
}

function h1(doc: Doc, text: string) {
  doc.font("Helvetica-Bold").fontSize(18).fillColor(COLORS.text).text(pdfSafe(text), MARGIN, doc.y, { width: contentWidth(doc) });
  doc.moveDown(0.3);
}

function h2(doc: Doc, text: string) {
  ensure(doc, 60);
  doc.moveDown(0.6);
  doc.font("Helvetica-Bold").fontSize(13).fillColor(COLORS.accent).text(pdfSafe(text), MARGIN, doc.y, { width: contentWidth(doc) });
  const y = doc.y + 2;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + contentWidth(doc), y).lineWidth(0.5).strokeColor(COLORS.rule).stroke();
  doc.y = y + 6;
}

function h3(doc: Doc, text: string) {
  ensure(doc, 40);
  doc.moveDown(0.3);
  doc.font("Helvetica-Bold").fontSize(10).fillColor(COLORS.text).text(pdfSafe(text), MARGIN, doc.y, { width: contentWidth(doc) });
  doc.moveDown(0.2);
}

function para(doc: Doc, text: string, o: { size?: number; color?: string; font?: string } = {}) {
  const s = pdfSafe(text);
  doc.font(o.font ?? "Helvetica").fontSize(o.size ?? 9);
  ensure(doc, Math.min(doc.heightOfString(s, { width: contentWidth(doc) }), 200));
  doc.fillColor(o.color ?? COLORS.text).text(s, MARGIN, doc.y, { width: contentWidth(doc), lineGap: 1.5 });
  doc.moveDown(0.3);
}

function statement(doc: Doc, s: { status: DataStatus; text: string } | null | undefined) {
  if (!s) return;
  const label = s.status === "ok" ? "" : `${s.status.toUpperCase()}: `;
  para(doc, `${label}${s.text}`, { color: STATUS_COLOR[s.status], font: s.status === "ok" ? "Helvetica" : "Helvetica-Bold" });
}

function kv(doc: Doc, rows: [string, string][]) {
  const w = contentWidth(doc);
  for (const [k, v] of rows) {
    const value = pdfSafe(v);
    doc.font("Helvetica").fontSize(9);
    const h = Math.max(doc.heightOfString(value, { width: w - 130 }), 11);
    ensure(doc, h + 2);
    const y = doc.y;
    doc.font("Helvetica-Bold").fillColor(COLORS.muted).text(pdfSafe(k), MARGIN, y, { width: 125 });
    doc.font("Helvetica").fillColor(COLORS.text).text(value, MARGIN + 130, y, { width: w - 130 });
    doc.y = y + h + 2;
  }
  doc.x = MARGIN;
}

/** A simple ruled table that repeats its header on page breaks. Column widths are fractions of the content width. */
function table(doc: Doc, cols: Col[], rows: string[][], fontSize = 7.5) {
  const total = contentWidth(doc);
  const sum = cols.reduce((a, c) => a + c.width, 0);
  const widths = cols.map((c) => (c.width / sum) * total);
  const pad = 3;
  const heightOf = (cells: string[], font: string) => {
    doc.font(font).fontSize(fontSize);
    return Math.max(...cells.map((c, i) => doc.heightOfString(c, { width: widths[i]! - 2 * pad }))) + 2 * pad;
  };
  const drawRow = (cells: string[], font: string, fill: string | null) => {
    const h = heightOf(cells, font);
    let x = MARGIN;
    const y = doc.y;
    if (fill) doc.rect(MARGIN, y, total, h).fill(fill);
    doc.font(font).fontSize(fontSize).fillColor(COLORS.text);
    cells.forEach((c, i) => {
      doc.text(c, x + pad, y + pad, { width: widths[i]! - 2 * pad, align: cols[i]!.align ?? "left" });
      x += widths[i]!;
    });
    doc.moveTo(MARGIN, y + h).lineTo(MARGIN + total, y + h).lineWidth(0.3).strokeColor(COLORS.rule).stroke();
    doc.y = y + h;
  };
  const header = cols.map((c) => pdfSafe(c.header));
  ensure(doc, heightOf(header, "Helvetica-Bold") + 20);
  drawRow(header, "Helvetica-Bold", COLORS.head);
  for (const r of rows) {
    const cells = r.map((c) => pdfSafe(clip(c)));
    if (doc.y + heightOf(cells, "Helvetica") > bottom(doc)) {
      doc.addPage();
      drawRow(header, "Helvetica-Bold", COLORS.head);
    }
    drawRow(cells, "Helvetica", null);
  }
  doc.x = MARGIN;
  doc.y += 6;
}

// ── Map figure ─────────────────────────────────────────────────

type Ring = [number, number][];

function polygonsOf(g: { type: string; coordinates: unknown } | null): Ring[][] {
  if (!g) return [];
  if (g.type === "Polygon") return [g.coordinates as Ring[]];
  if (g.type === "MultiPolygon") return g.coordinates as Ring[][];
  return [];
}

function niceDistance(maxMeters: number): number {
  const steps = [1, 2, 5];
  let best = 1;
  for (let p = 0; p < 7; p++) for (const s of steps) if (s * 10 ** p <= maxMeters) best = s * 10 ** p;
  return best;
}

function drawMap(doc: Doc, content: ReportContent, png: Buffer | null) {
  const aoi = content.aoi;
  const polys = polygonsOf(aoi?.geometry ?? null);
  if (!aoi || polys.length === 0) return;
  const raster = content.observations?.latest?.raster ?? null;

  const frameW = contentWidth(doc);
  const frameH = 250;
  ensure(doc, frameH + 110); // keep the heading with its figure
  h2(doc, "Map");
  const top = doc.y;

  // Extent: AOI plus raster footprint (when the raster will be drawn).
  const lons: number[] = [];
  const lats: number[] = [];
  const extend = ([x, y]: [number, number]) => {
    lons.push(x);
    lats.push(y);
  };
  for (const p of polys) for (const r of p) r.forEach(extend);
  if (raster && png) raster.corners.forEach(extend);
  const [w, e, s, nn] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
  const lat0 = (s + nn) / 2;
  const kx = Math.cos((lat0 * Math.PI) / 180); // simple equirectangular frame
  const spanX = Math.max((e - w) * kx, 1e-9);
  const spanY = Math.max(nn - s, 1e-9);
  const pad = 16;
  const scale = Math.min((frameW - 2 * pad) / spanX, (frameH - 2 * pad) / spanY);
  const ox = MARGIN + (frameW - spanX * scale) / 2;
  const oy = top + (frameH - spanY * scale) / 2;
  const px = (lon: number) => ox + (lon - w) * kx * scale;
  const py = (lat: number) => oy + (nn - lat) * scale;

  doc.save();
  doc.rect(MARGIN, top, frameW, frameH).fill("#f8fafc");
  doc.rect(MARGIN, top, frameW, frameH).clip();
  let rasterDrawn = false;
  if (raster && png) {
    const rx = raster.corners.map((c) => c[0]);
    const ry = raster.corners.map((c) => c[1]);
    const x0 = px(Math.min(...rx));
    const y0 = py(Math.max(...ry));
    try {
      doc.image(png, x0, y0, { width: px(Math.max(...rx)) - x0, height: py(Math.min(...ry)) - y0 });
      rasterDrawn = true;
    } catch {
      rasterDrawn = false;
    }
  }
  doc.lineWidth(1.5).strokeColor(COLORS.aoi);
  for (const p of polys) {
    for (const ring of p) {
      ring.forEach(([x, y], i) => (i === 0 ? doc.moveTo(px(x), py(y)) : doc.lineTo(px(x), py(y))));
      doc.closePath().stroke();
    }
  }
  doc.restore();
  doc.rect(MARGIN, top, frameW, frameH).lineWidth(0.5).strokeColor(COLORS.rule).stroke();

  // North arrow and scale bar.
  const nx = MARGIN + frameW - 20;
  doc.polygon([nx, top + 10], [nx - 5, top + 24], [nx + 5, top + 24]).fill(COLORS.text);
  doc.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.text).text("N", nx - 3, top + 26);
  const metersPerPoint = 111_320 / scale; // 1 pt spans 1/scale degrees of latitude (≈ 111.32 km per degree)
  const barMeters = niceDistance(metersPerPoint * frameW * 0.25);
  const barPts = barMeters / metersPerPoint;
  const by = top + frameH - 14;
  doc.rect(MARGIN + 10, by, barPts, 4).fill(COLORS.text);
  doc.font("Helvetica").fontSize(7).fillColor(COLORS.text).text(barMeters >= 1000 ? `${barMeters / 1000} km` : `${barMeters} m`, MARGIN + 14 + barPts, by - 2);

  // Legend.
  doc.y = top + frameH + 6;
  const ly = doc.y;
  doc.moveTo(MARGIN, ly + 5).lineTo(MARGIN + 18, ly + 5).lineWidth(1.5).strokeColor(COLORS.aoi).stroke();
  doc.font("Helvetica").fontSize(8).fillColor(COLORS.text).text(pdfSafe(`AOI boundary: ${aoi.name}${aoi.is_synthetic ? " (development placeholder)" : ""}`), MARGIN + 24, ly);
  doc.y = ly + 13;
  if (rasterDrawn && raster) {
    const stops = raster.legend.stops ?? [];
    let x = MARGIN;
    const y = doc.y;
    doc.font("Helvetica").fontSize(7);
    for (const st of stops.slice(0, 10)) {
      doc.rect(x, y, 10, 8).fill(st.color);
      const label = pdfSafe(st.label ?? String(st.value));
      doc.fillColor(COLORS.text).text(label, x + 12, y);
      x += 14 + doc.widthOfString(label) + 8;
    }
    if (!stops.length && (raster.legend.min !== undefined || raster.legend.max !== undefined)) {
      doc.fillColor(COLORS.text).text(pdfSafe(`${raster.legend.kind.toUpperCase()} scale ${raster.legend.min ?? ""} to ${raster.legend.max ?? ""}`), MARGIN, y);
    }
    doc.y = y + 12;
    const latest = content.observations!.latest!;
    para(doc, `Image: ${latest.kind.toUpperCase()} from ${latest.collection}, acquired ${dt(latest.observed_at)} [${latest.evidence_id}]. Shown in a simple equirectangular frame for orientation; not a survey-grade map.`, { size: 7.5, color: COLORS.muted });
  } else {
    para(doc, raster && !png ? "The rendered image for the latest usable observation is not available in storage." : "No rendered imagery is available for the latest usable observation; the AOI outline is shown alone.", {
      size: 7.5,
      color: COLORS.muted,
    });
  }
}

// ── Season comparison (change evidence reports) ───────────────

/** Stored PNGs a change evidence report draws (true colour of both images, ΔNDVI). */
export type ComparisonImages = { baseline?: Buffer | null; comparison?: Buffer | null; delta?: Buffer | null };

type Corners = [[number, number], [number, number], [number, number], [number, number]];
type View = [number, number, number, number];

const extentOf = (corners: Corners): View => {
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

/** A view around a bounding box, padded, with at least ~300 m on a side. */
function viewAround(b: View, padFactor = 0.75): View {
  const lat0 = (b[1] + b[3]) / 2;
  const minDeg = 0.003;
  const dx = Math.max(b[2] - b[0], minDeg / Math.max(Math.cos((lat0 * Math.PI) / 180), 0.2));
  const dy = Math.max(b[3] - b[1], minDeg);
  const pad = Math.max(dx, dy) * padFactor;
  return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
}

/**
 * Draw a georeferenced PNG cropped to `view` inside a frame, with optional
 * outlines. The frame is equirectangular (cos-latitude scaled), which is
 * accurate enough at area scale for orientation; pixels are not resampled
 * by ORYN (PDF viewers may smooth them).
 */
/** An image embedded once and drawn on many pages (pdfkit reuses an opened image object). */
type OpenedImage = object;
const openImage = (doc: Doc, b: Buffer | null | undefined): OpenedImage | null => {
  if (!b) return null;
  try {
    return (doc as unknown as { openImage(src: Buffer): OpenedImage }).openImage(b);
  } catch {
    return null;
  }
};

function drawGeoImage(
  doc: Doc,
  image: OpenedImage | null,
  corners: Corners | null,
  view: View,
  frame: { x: number; y: number; w: number; h: number },
  outlines: { rings: Ring[][]; color: string; width?: number; label?: string; at?: [number, number] }[],
) {
  const lat0 = (view[1] + view[3]) / 2;
  const kx = Math.cos((lat0 * Math.PI) / 180);
  const spanX = Math.max((view[2] - view[0]) * kx, 1e-9);
  const spanY = Math.max(view[3] - view[1], 1e-9);
  const scale = Math.min(frame.w / spanX, frame.h / spanY);
  const ox = frame.x + (frame.w - spanX * scale) / 2;
  const oy = frame.y + (frame.h - spanY * scale) / 2;
  const px = (lon: number) => ox + (lon - view[0]) * kx * scale;
  const py = (lat: number) => oy + (view[3] - lat) * scale;
  doc.save();
  doc.rect(frame.x, frame.y, frame.w, frame.h).fill("#e5e7eb");
  doc.rect(frame.x, frame.y, frame.w, frame.h).clip();
  let drawn = false;
  if (image && corners) {
    const e = extentOf(corners);
    try {
      doc.image(image as Buffer, px(e[0]), py(e[3]), { width: px(e[2]) - px(e[0]), height: py(e[1]) - py(e[3]) });
      drawn = true;
    } catch {
      drawn = false;
    }
  }
  for (const o of outlines) {
    doc.lineWidth(o.width ?? 1.2).strokeColor(o.color);
    for (const poly of o.rings) {
      for (const ring of poly) {
        ring.forEach(([x, y], i) => (i ? doc.lineTo(px(x), py(y)) : doc.moveTo(px(x), py(y))));
        doc.closePath().stroke();
      }
    }
    if (o.label && o.at) {
      doc.font("Helvetica-Bold").fontSize(8).fillColor(o.color).text(pdfSafe(o.label), px(o.at[0]) + 3, py(o.at[1]) - 4, { lineBreak: false });
    }
  }
  doc.restore();
  doc.rect(frame.x, frame.y, frame.w, frame.h).lineWidth(0.5).strokeColor(COLORS.rule).stroke();
  if (!drawn) {
    doc.font("Helvetica").fontSize(7).fillColor(COLORS.muted).text("Image not available", frame.x + 4, frame.y + 4, { width: frame.w - 8 });
  }
  return drawn;
}

const FINDING_COLOR = "#facc15";

function drawComparison(doc: Doc, c: ReportContent, cmp: ComparisonSection, buffers: ComparisonImages) {
  const imgs = { baseline: openImage(doc, buffers.baseline), comparison: openImage(doc, buffers.comparison), delta: openImage(doc, buffers.delta) };
  h2(doc, "Season comparison");
  statement(doc, cmp.statement);
  const outcomeBox = pdfSafe(`${cmp.outcome_label}. ${cmp.outcome_detail}`);
  doc.font("Helvetica-Bold").fontSize(9.5);
  const bh = doc.heightOfString(outcomeBox, { width: contentWidth(doc) - 16 }) + 12;
  ensure(doc, bh + 4);
  const by = doc.y;
  const color = cmp.compared ? COLORS.accent : STATUS_COLOR.missing;
  doc.rect(MARGIN, by, contentWidth(doc), bh).lineWidth(1).strokeColor(color).stroke();
  doc.fillColor(color).text(outcomeBox, MARGIN + 8, by + 6, { width: contentWidth(doc) - 16 });
  doc.y = by + bh + 6;
  kv(doc, [
    ["Baseline period", `${cmp.periods.baseline.from} to ${cmp.periods.baseline.to}`],
    ["Comparison period", `${cmp.periods.comparison.from} to ${cmp.periods.comparison.to}`],
    ["Sensor", `${cmp.sensor} — ${cmp.provider}`],
    ["Method", `${cmp.method.name} (${cmp.method.model_id}@${cmp.method.model_version})`],
    ["Thresholds", `NDVI change >= ${cmp.method.threshold}; region >= ${formatArea(cmp.method.min_area_m2)}; at least ${Math.round(cmp.method.min_overlap * 100)}% of the area clear in both images`],
    ...(cmp.measurements
      ? ([
          ["Clear in both images", pct1(cmp.measurements.overlap)],
          ["Area covered by the tile", pct1(cmp.measurements.coverage_fraction)],
          ["Pixel grid", cmp.measurements.same_grid === null ? "-" : cmp.measurements.same_grid ? "Same grid (no resampling)" : "Different grids (baseline resampled)"],
          ["Time between images", cmp.measurements.days_between === null ? "-" : `${cmp.measurements.days_between} days; ${cmp.measurements.seasonal_offset_days ?? "-"} days apart in the season`],
        ] as [string, string][])
      : []),
    ["Evidence", cmp.evidence_id],
  ]);
  para(doc, cmp.method.description, { size: 7.5, color: COLORS.muted });

  const pair = [cmp.images.baseline, cmp.images.comparison].filter((i): i is NonNullable<typeof i> => Boolean(i));
  if (pair.length) {
    h3(doc, "Images compared");
    table(
      doc,
      [
        { header: "Role", width: 0.8 },
        { header: "Scene", width: 2.2 },
        { header: "Acquired", width: 1.2 },
        { header: "Clear / covered", width: 1 },
        { header: "Tile (EPSG)", width: 1 },
        { header: "Licence", width: 1.4 },
        { header: "Evidence", width: 0.6 },
      ],
      pair.map((i) => [
        i.role,
        `${i.external_id}${i.platform ? ` (${i.platform})` : ""}`,
        dt(i.acquired_at),
        `${pct1(i.clear_fraction)} / ${pct1(i.coverage_fraction)}`,
        `${i.grid_code ?? "-"} (${i.epsg ?? "-"})`,
        i.license ?? "not recorded",
        i.evidence_id,
      ]),
    );
  }

  // Overview of the area with the findings outlined on the comparison image.
  const after = cmp.images.comparison;
  const aoiPolys = polygonsOf(c.aoi?.geometry ?? null);
  if (after?.corners && c.aoi?.bbox) {
    ensure(doc, 300);
    h3(doc, "Overview: comparison image with candidate changes outlined");
    const top = doc.y;
    drawGeoImage(doc, imgs.comparison ?? null, after.corners, viewAround(c.aoi.bbox as View, 0.08), { x: MARGIN, y: top, w: contentWidth(doc), h: 260 }, [
      { rings: aoiPolys, color: COLORS.aoi, width: 1.2 },
      ...cmp.findings.map((f, i) => ({ rings: polygonsOf(f.geometry), color: FINDING_COLOR, width: 1.4, label: String(i + 1), at: [f.bbox[2], f.bbox[3]] as [number, number] })),
    ]);
    doc.y = top + 266;
    para(doc, `True colour, ${after.external_id}, acquired ${dt(after.acquired_at)}. Orange: area boundary. Yellow: candidate changes, numbered as in the table. Sentinel-2 true colour has 10 m pixels.`, { size: 7.5, color: COLORS.muted });
  }

  if (cmp.findings.length) {
    h3(doc, "Candidate changes");
    table(
      doc,
      [
        { header: "#", width: 0.3 },
        { header: "Finding", width: 2.4 },
        { header: "Area", width: 0.9, align: "right" },
        { header: "Mean NDVI change", width: 0.9, align: "right" },
        { header: "Evidence grade", width: 0.8 },
        { header: "Review", width: 0.9 },
        { header: "Evidence", width: 0.6 },
      ],
      cmp.findings.map((f, i) => [
        String(i + 1),
        f.title,
        f.area_m2 === null ? "-" : formatArea(f.area_m2),
        n(f.mean_delta, 2),
        f.evidence_grade,
        f.verification_status.replace(/_/g, " "),
        f.evidence_id,
      ]),
    );
    if (cmp.findings_listed_only > 0) para(doc, `The ${cmp.findings_listed_only} smallest findings are listed above only; each of the first ${MAX_FINDING_PAGES} has its own page.`, { size: 7.5, color: COLORS.muted });
  }

  cmp.findings.slice(0, MAX_FINDING_PAGES).forEach((f, i) => {
    doc.addPage();
    h2(doc, `Finding ${i + 1} of ${cmp.findings.length}: ${f.title}`);
    para(doc, "A candidate change is a measured difference in NDVI between two satellite images. It does not establish what happened on the ground; review it, usually with a field check, before acting.", { size: 8, color: COLORS.muted });
    kv(doc, [
      ["Location", `${n(f.centroid[1], 5)}, ${n(f.centroid[0], 5)} (lat, lon of the centre)`],
      ["Area", f.area_m2 === null ? "-" : `${formatArea(f.area_m2)}${f.pixel_count ? ` (${f.pixel_count} pixels of 10 m)` : ""}`],
      ["Mean NDVI change", `${n(f.mean_delta, 3)}${f.direction ? ` (${f.direction})` : ""}`],
      ["Evidence grade", f.evidence_grade],
      ["Review", f.verification_status.replace(/_/g, " ")],
      ["Evidence", f.evidence_id],
    ]);
    h3(doc, "Why this grade");
    for (const r of f.evidence_reasons) para(doc, `- ${r}`, { size: 8.5 });
    ensure(doc, 230);
    const top = doc.y + 4;
    const gap = 8;
    const w = (contentWidth(doc) - 2 * gap) / 3;
    const view = viewAround(f.bbox);
    const rings = polygonsOf(f.geometry);
    const panels: { title: string; image: OpenedImage | null; corners: Corners | null }[] = [
      { title: `Before: ${d10(cmp.images.baseline?.acquired_at)}`, image: imgs.baseline ?? null, corners: cmp.images.baseline?.corners ?? null },
      { title: `After: ${d10(cmp.images.comparison?.acquired_at)}`, image: imgs.comparison ?? null, corners: cmp.images.comparison?.corners ?? null },
      { title: "NDVI change (red: decrease, green: increase)", image: imgs.delta ?? null, corners: cmp.delta?.corners ?? null },
    ];
    panels.forEach((pnl, k) => {
      const x = MARGIN + k * (w + gap);
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COLORS.text).text(pdfSafe(pnl.title), x, top, { width: w });
      drawGeoImage(doc, pnl.image, pnl.corners, view, { x, y: top + 12, w, h: w }, [{ rings, color: FINDING_COLOR, width: 1.4 }]);
    });
    doc.y = top + 12 + w + 6;
    para(doc, "Crops of the stored images at their native 10 m pixels (true colour for before and after). The yellow outline is the candidate region.", { size: 7.5, color: COLORS.muted });
    if (f.notes.length) {
      h3(doc, "Review notes");
      for (const note of f.notes) para(doc, `${dt(note.created_at)}${note.author ? ` — ${note.author}` : ""}: ${clip(note.body, 600)}`, { size: 8.5 });
    }
  });

  for (const which of ["baseline", "comparison"] as const) {
    const list = cmp.considered[which];
    if (!list.length) continue;
    h3(doc, `Images considered in the ${which} period`);
    table(
      doc,
      [
        { header: "Acquired", width: 1 },
        { header: "Scene", width: 2 },
        { header: "Clear", width: 0.6, align: "right" },
        { header: "Decision", width: 3.2 },
      ],
      list.map((d) => [d10(d.acquired_at), d.external_id, pct1(d.clear_fraction), d.why]),
      7,
    );
  }
  for (const note of cmp.notes) para(doc, note, { size: 7.5, color: COLORS.muted });
}

// ── Document ───────────────────────────────────────────────────

export async function renderReportPdf(content: ReportContent, opts: { rasterPng?: Buffer | null; comparisonImages?: ComparisonImages } = {}): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: MARGIN, bottom: MARGIN + 10, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: {
      Title: pdfSafe(content.report.title),
      Author: "ORYN",
      Subject: pdfSafe(`${REPORT_TYPE_LABEL[content.report.type]} — ${content.org.name}`),
      CreationDate: new Date(content.report.generated_at),
    },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  renderBody(doc, content, opts.rasterPng ?? null, opts.comparisonImages ?? {});

  // Footer on every page (margins lifted so writing in the footer band never adds a page).
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("Helvetica").fontSize(7).fillColor(COLORS.muted).text(
      pdfSafe(`ORYN · ${content.report.title} · generated ${dt(content.report.generated_at)} · page ${i - range.start + 1} of ${range.count}`),
      MARGIN,
      doc.page.height - 35,
      { width: contentWidth(doc), align: "center", lineBreak: false },
    );
    doc.page.margins.bottom = saved;
  }
  doc.end();
  return done;
}

function renderBody(doc: Doc, c: ReportContent, png: Buffer | null, comparisonImages: ComparisonImages = {}) {
  // Title block
  doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.accent).text("ORYN", MARGIN, MARGIN);
  doc.moveDown(0.2);
  h1(doc, c.report.title);
  kv(doc, [
    ["Organization", `${c.org.name}${c.org.is_synthetic ? " (synthetic sample data)" : ""}`],
    ...(c.aoi
      ? ([
          ["Area of interest", `${c.aoi.name} — ${c.aoi.kind.replace(/_/g, " ")}, ${formatArea(c.aoi.area_m2)} [${c.aoi.evidence_id}]`],
          ["Boundary source", `${String(c.aoi.boundary_source.method ?? "not recorded")}${c.aoi.is_synthetic ? " — development placeholder, not a surveyed boundary" : ""}`],
        ] as [string, string][])
      : []),
    ["Report type", REPORT_TYPE_LABEL[c.report.type]],
    ["Period", `${d10(c.report.period.from)} to ${d10(c.report.period.to)}`],
    ["Generated", dt(c.report.generated_at)],
  ]);
  doc.moveDown(0.3);
  const box = pdfSafe(`Data currency: ${c.data_currency.statement}`);
  doc.font("Helvetica-Bold").fontSize(9.5);
  const bh = doc.heightOfString(box, { width: contentWidth(doc) - 16 }) + 12;
  ensure(doc, bh + 4);
  const by = doc.y;
  doc.rect(MARGIN, by, contentWidth(doc), bh).lineWidth(1).strokeColor(STATUS_COLOR[c.data_currency.status]).stroke();
  doc.fillColor(STATUS_COLOR[c.data_currency.status]).text(box, MARGIN + 8, by + 6, { width: contentWidth(doc) - 16 });
  doc.y = by + bh + 6;

  // Summary
  if (c.summary) {
    h2(doc, "Summary");
    para(doc, c.summary.text, { size: 9.5 });
    para(doc, `Summary method: ${c.summary.method}. Bracketed ids refer to the evidence index at the end of this report.`, { size: 7.5, color: COLORS.muted });
  }

  if (c.comparison) drawComparison(doc, c, c.comparison, comparisonImages);
  else drawMap(doc, c, png);

  if (c.observations) {
    h2(doc, "Observations");
    statement(doc, c.observations.statement);
    const l = c.observations.latest;
    if (l) {
      h3(doc, "Latest usable observation");
      kv(doc, [
        ["Acquired", dt(l.observed_at)],
        ["Processed by ORYN", dt(l.processed_at)],
        ["Source", `${l.collection}${l.platform ? ` (${l.platform})` : ""} — ${l.provider_id}`],
        ["Model", `${l.model_id}@${l.model_version} (${l.result_class.replace(/_/g, " ")})`],
        ["Metrics", Object.entries(l.metrics).filter(([k]) => !["total_pixels", "valid_pixels", "pixel_area_m2"].includes(k)).map(([k, v]) => `${k} ${n(v)}`).join(", ") || "-"],
        ["Quality", `coverage ${pctOf(l.quality.coverage_fraction)}, masked ${pctOf(l.quality.masked_fraction)}, scene cloud ${n(l.quality.scene_cloud_cover, 1)}%${l.quality.flags.length ? `, flags: ${l.quality.flags.join(", ")}` : ""}`],
        ["Evidence", l.evidence_id],
      ]);
    }
    if (c.observations.series.length) {
      h3(doc, "Observation series (valid and unusable)");
      table(
        doc,
        [
          { header: "Acquired", width: 1.1 },
          { header: "Kind", width: 0.7 },
          { header: "Collection", width: 1.3 },
          { header: "Status", width: 2.2 },
          { header: "Mean / water area", width: 1.2, align: "right" },
          { header: "Valid px", width: 0.7, align: "right" },
          { header: "Cloud", width: 0.6, align: "right" },
          { header: "Evidence", width: 0.7 },
        ],
        c.observations.series.map((o) => [
          d10(o.observed_at),
          o.kind,
          o.collection,
          o.status === "valid" ? "valid" : `UNUSABLE: ${o.unusable_reason ?? "reason not recorded"}`,
          o.status !== "valid" ? "-" : o.metrics.water_area_m2 !== undefined ? formatArea(o.metrics.water_area_m2) : n(o.metrics.mean),
          pctOf(o.metrics.valid_fraction),
          o.quality.scene_cloud_cover == null ? "-" : `${n(o.quality.scene_cloud_cover, 1)}%`,
          o.evidence_id,
        ]),
      );
    }
  }

  if (c.detections) {
    h2(doc, "Detections (candidate changes)");
    statement(doc, c.detections.statement);
    if (c.detections.items.length) {
      table(
        doc,
        [
          { header: "Compared", width: 1.6 },
          { header: "Type", width: 1.2 },
          { header: "Area", width: 1.1, align: "right" },
          { header: "Change", width: 0.9, align: "right" },
          { header: "Evidence grade", width: 0.9 },
          { header: "Verification", width: 1.1 },
          { header: "Evidence", width: 0.6 },
        ],
        c.detections.items.map((d) => [
          `${d10(d.baseline_observed_at)} -> ${d10(d.comparison_observed_at)}`,
          d.type.replace(/_/g, " "),
          d.area_m2 == null ? "-" : formatArea(d.area_m2),
          d.mean_delta == null ? (d.direction ?? "-") : n(d.mean_delta),
          d.evidence_grade,
          d.verification_status.replace(/_/g, " "),
          d.evidence_id,
        ]),
      );
    }
  }

  if (c.weather) {
    h2(doc, "Weather");
    statement(doc, c.weather.statement);
    for (const k of c.weather.kinds) {
      h3(doc, `${k.label} (${k.record_kind.replace("_", " ")})`);
      para(doc, k.caveat, { size: 7.5, color: COLORS.muted });
      statement(doc, k.statement);
      if (k.variables.length) {
        table(
          doc,
          [
            { header: "Variable", width: 1.6 },
            { header: "Days", width: 1.5 },
            { header: "Total", width: 0.7, align: "right" },
            { header: "Min", width: 0.6, align: "right" },
            { header: "Max", width: 0.6, align: "right" },
            { header: "Mean", width: 0.6, align: "right" },
            { header: "Source", width: 1.2 },
            { header: "Evidence", width: 0.6 },
          ],
          k.variables.map((v) => [
            `${v.label} (${v.unit})`,
            `${v.from} to ${v.to} (${v.days} d)`,
            v.total == null ? "-" : n(v.total, 1),
            n(v.min, 1),
            n(v.max, 1),
            n(v.mean, 1),
            `${v.providers.join(", ")}${v.issued_at ? `; issued ${dt(v.issued_at)}` : ""}`,
            v.evidence_id,
          ]),
        );
      }
    }
  }

  if (c.warnings) {
    h2(doc, "Official warnings");
    statement(doc, c.warnings.statement);
    if (c.warnings.items.length) {
      para(doc, "Warnings are issued by the named agency and relayed as issued; ORYN does not assess them.", { size: 7.5, color: COLORS.muted });
      table(
        doc,
        [
          { header: "Warning", width: 2.4 },
          { header: "Severity", width: 0.8 },
          { header: "Certainty", width: 0.8 },
          { header: "Onset", width: 1.1 },
          { header: "Ends", width: 1.1 },
          { header: "Issuer", width: 0.7 },
          { header: "Evidence", width: 0.6 },
        ],
        c.warnings.items.map((w) => [w.title, w.severity ?? "-", w.certainty ?? "-", dt(w.event_start), dt(w.event_end), w.provider_id, w.evidence_id]),
      );
    }
  }

  if (c.news) {
    h2(doc, "News reports (claims)");
    para(doc, c.news.note, { size: 8, color: COLORS.muted });
    statement(doc, c.news.statement);
    if (c.news.stories.length) {
      table(
        doc,
        [
          { header: "Story", width: 3 },
          { header: "Category", width: 1 },
          { header: "First published", width: 1.1 },
          { header: "Independent sources", width: 0.9, align: "right" },
          { header: "Evidence", width: 0.6 },
        ],
        c.news.stories.map((s) => [s.title, s.category, d10(s.first_published_at), String(s.independent_sources), s.evidence_id]),
      );
    }
    if (c.news.reported_events.length) {
      h3(doc, "Reported events");
      table(
        doc,
        [
          { header: "Report", width: 3 },
          { header: "Claim status", width: 1 },
          { header: "Published", width: 1 },
          { header: "Evidence", width: 0.6 },
        ],
        c.news.reported_events.map((e) => [e.title, e.claim_status, d10(e.published_at), e.evidence_id]),
      );
    }
  }

  if (c.alerts) {
    h2(doc, "Unresolved alerts");
    statement(doc, c.alerts.statement);
    if (c.alerts.open.length) {
      table(
        doc,
        [
          { header: "Raised", width: 1 },
          { header: "Severity", width: 0.7 },
          { header: "Status", width: 0.9 },
          { header: "Alert", width: 3 },
          { header: "Basis", width: 1.1 },
          { header: "Evidence", width: 0.6 },
        ],
        c.alerts.open.map((a) => [d10(a.created_at), a.severity, a.status, `${a.title}${a.from_reprocessing ? " (from reprocessed data)" : ""}`, (a.basis ?? "-").replace(/_/g, " "), a.evidence_id]),
      );
    }
  }

  if (c.processing) {
    h2(doc, "Processing history");
    statement(doc, c.processing.statement);
    if (c.processing.runs.length) {
      table(
        doc,
        [
          { header: "Started", width: 1.2 },
          { header: "Model", width: 1.3 },
          { header: "Status", width: 0.9 },
          { header: "Messages / error", width: 3 },
          { header: "Evidence", width: 0.6 },
        ],
        c.processing.runs.map((r) => [dt(r.started_at), `${r.model_id}@${r.model_version}`, r.status.replace(/_/g, " "), [r.error, ...r.messages].filter(Boolean).join("; ") || "-", r.evidence_id]),
      );
    }
  }

  if (c.audit) {
    h2(doc, "Audit trail");
    statement(doc, c.audit.statement);
    if (c.audit.events.length) {
      table(
        doc,
        [
          { header: "Time", width: 1.3 },
          { header: "Actor", width: 1.4 },
          { header: "Action", width: 1.4 },
          { header: "Target", width: 2 },
        ],
        c.audit.events.map((e) => [dt(e.created_at), `${e.actor_type}${e.actor_label ? `: ${e.actor_label}` : ""}`, e.action, e.target_type ? `${e.target_type} ${e.target_id ?? ""}` : "-"]),
        7,
      );
    }
  }

  h2(doc, "Sources, licences, and attribution");
  if (c.sources.assets.length) {
    table(
      doc,
      [
        { header: "Scene", width: 2.2 },
        { header: "Collection", width: 1.2 },
        { header: "Acquired", width: 0.9 },
        { header: "Licence", width: 1.2 },
        { header: "Attribution", width: 1.6 },
        { header: "Evidence", width: 0.6 },
      ],
      c.sources.assets.map((a) => [a.external_id, `${a.collection} (${a.provider_id})`, d10(a.acquired_at), a.license ?? "not recorded", a.attribution ?? "-", a.evidence_id]),
    );
  } else {
    para(doc, "No source scenes were used in this report.");
  }
  if (c.sources.weather_providers.length) para(doc, `Weather providers: ${c.sources.weather_providers.join(", ")}.`);
  if (c.sources.news_providers.length) para(doc, `News providers: ${c.sources.news_providers.join(", ")}.`);
  for (const a of c.sources.attributions) para(doc, a, { size: 8, color: COLORS.muted });

  h2(doc, "Limitations");
  for (const l of c.limitations.general) para(doc, `[${l.id}] ${l.text}`, { size: 8.5 });
  for (const m of c.limitations.models) {
    h3(doc, `${m.name} (${m.model_id}@${m.model_version}, ${m.result_class.replace(/_/g, " ")})`);
    for (const l of m.limitations) para(doc, `[${l.id}] ${l.text}`, { size: 8 });
  }

  h2(doc, "Evidence index");
  para(doc, "Each id maps to the stored rows the reported values came from.", { size: 7.5, color: COLORS.muted });
  table(
    doc,
    [
      { header: "Id", width: 0.5 },
      { header: "Kind", width: 0.9 },
      { header: "Table", width: 1.1 },
      { header: "Rows", width: 2.4 },
      { header: "Description", width: 2.6 },
    ],
    Object.values(c.evidence)
      .filter((e) => e.kind !== "limitation")
      .map((e) => [e.id, e.kind.replace(/_/g, " "), e.table ?? "-", e.row_ids.length > 4 ? `${e.row_ids.slice(0, 4).join(", ")} … (${e.row_ids.length} rows)` : e.row_ids.join(", "), e.label]),
    6.5,
  );
}
