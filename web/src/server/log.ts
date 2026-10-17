/**
 * Structured JSON logging with secret redaction.
 *
 * Fields whose key looks like a credential are replaced before anything is
 * written, and string values that look like bearer tokens or signed URLs have
 * their query strings stripped.
 */
import { env } from "@/server/config/env";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
/** Set per deployed service (web, worker, migrate) so mixed log streams stay attributable. */
const SERVICE = process.env.ORYN_SERVICE?.trim() || null;
const SECRET_KEY = /(secret|token|password|passwd|authorization|cookie|api[-_]?key|sas|signature|credential)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), stack: value.stack?.split("\n").slice(0, 6).join("\n") };
  }
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    return out;
  }
  return value;
}

function redactString(s: string): string {
  return s
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/(https?:\/\/[^\s?"']+)\?[^\s"']*(sig|se|token|X-Amz-Signature)=[^\s"']*/gi, "$1?[redacted]")
    .replace(/oryn_[a-z0-9]{8}_[A-Za-z0-9_-]{20,}/g, "oryn_[redacted]");
}

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  let min: Level = "info";
  try {
    min = env.logLevel();
  } catch {
    /* fall back to info */
  }
  if (ORDER[level] < ORDER[min]) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(SERVICE ? { svc: SERVICE } : {}), ...(fields ? (redact(fields) as object) : {}) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
  child(bound: Record<string, unknown>) {
    return {
      debug: (msg: string, f?: Record<string, unknown>) => write("debug", msg, { ...bound, ...f }),
      info: (msg: string, f?: Record<string, unknown>) => write("info", msg, { ...bound, ...f }),
      warn: (msg: string, f?: Record<string, unknown>) => write("warn", msg, { ...bound, ...f }),
      error: (msg: string, f?: Record<string, unknown>) => write("error", msg, { ...bound, ...f }),
    };
  },
};

export { redactString };
