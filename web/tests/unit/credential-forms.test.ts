import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A form submitted before the page has hydrated falls back to the browser's
 * native submission. Without method="post" that is a GET, which puts the
 * password in the URL — and so in server logs, browser history, and proxies.
 * Every form with a password field must POST (or use a server action).
 */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : full.endsWith(".tsx") ? [full] : [];
  });
}

describe("credential forms", () => {
  it("never submit a password with GET, even before hydration", () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const file of files("src")) {
      const source = readFileSync(file, "utf8");
      if (!source.includes('type="password"')) continue;
      for (const match of source.matchAll(/<form\b[^>]*>/gs)) {
        checked++;
        const tag = match[0];
        if (!/method="post"/.test(tag) && !/action=\{/.test(tag)) offenders.push(`${file}: ${tag.slice(0, 80)}`);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(4);
    expect(offenders).toEqual([]);
  });
});
