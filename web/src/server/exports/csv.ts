/**
 * CSV writer (RFC 4180) with spreadsheet formula-injection protection.
 *
 * Guarantees
 *  - Fields containing a comma, double quote, CR, or LF are quoted, and
 *    embedded quotes are doubled. Records end with CRLF.
 *  - Text cells beginning with = + - @ (or tab / CR) are prefixed with a
 *    single quote so spreadsheet applications treat them as text, never as
 *    formulas (OWASP "CSV Injection"). Numeric cells are written as plain
 *    numbers — a number cannot be a formula, and negative values must stay
 *    numeric.
 */

export type CsvValue = string | number | boolean | Date | null | undefined;

export type CsvColumn<T> = { header: string; value: (row: T) => CsvValue };

export const CSV_CONTENT_TYPE = "text/csv; charset=utf-8; header=present";

const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/** Escape one cell. */
export function csvCell(v: CsvValue): string {
  let s: string;
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString();
  s = v;
  if (FORMULA_START.test(s)) s = `'${s}`;
  return NEEDS_QUOTES.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(values: readonly CsvValue[]): string {
  return values.map(csvCell).join(",");
}

/** Render rows as a CSV document (header + records, CRLF line endings). */
export function toCsv<T>(columns: readonly CsvColumn<T>[], rows: Iterable<T>): string {
  const lines = [csvRow(columns.map((c) => c.header))];
  for (const r of rows) lines.push(csvRow(columns.map((c) => c.value(r))));
  return `${lines.join("\r\n")}\r\n`;
}
