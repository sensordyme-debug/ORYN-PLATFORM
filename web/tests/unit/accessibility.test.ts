import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * WCAG 2.1 AA (1.4.3) needs 4.5:1 for normal-size text. Platform secondary
 * text is bone-50 at reduced opacity over the ink surfaces, so the lowest
 * opacity used for text decides whether it passes.
 */
const src = fileURLToPath(new URL("../../src", import.meta.url));
const css = readFileSync(path.join(src, "app/globals.css"), "utf8");
type Rgb = [number, number, number];
const token = (name: string): Rgb => {
  const hex = css.match(new RegExp(`--color-${name}:\\s*#([0-9a-f]{6})`, "i"))?.[1];
  if (!hex) throw new Error(`token ${name} not found`);
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const linear = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
const over = ([r, g, b]: Rgb, alpha: number, [br, bg, bb]: Rgb): Rgb => [r * alpha + br * (1 - alpha), g * alpha + bg * (1 - alpha), b * alpha + bb * (1 - alpha)];
const contrast = (a: Rgb, b: Rgb) => {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

// Surfaces platform text sits on (page, panels, raised rows).
const SURFACES = ["ink-950", "ink-900", "ink-850", "ink-800", "ink-750"];
const MIN_TEXT_OPACITY = 0.5;

describe("platform text contrast", () => {
  it(`bone-50 at ${MIN_TEXT_OPACITY * 100}% or more meets 4.5:1 on every surface`, () => {
    for (const s of SURFACES) expect(contrast(over(token("bone-50"), MIN_TEXT_OPACITY, token(s)), token(s)), s).toBeGreaterThanOrEqual(4.5);
  });

  it("the 45% opacity that platform text used before does not", () => {
    expect(contrast(over(token("bone-50"), 0.45, token("ink-850")), token("ink-850"))).toBeLessThan(4.5);
  });

  it("platform pages and components use no text opacity below 50%", () => {
    const dirs = ["app/(platform)", "components/platform", "components/map", "components/intel"];
    // Exempt by WCAG: decorative glyphs hidden from assistive technology, and labels of disabled controls.
    const allowed = [/aria-hidden="true" className=\{done \? "text-data-veg" : "text-bone-50\/30"\}/, /Available \? "text-bone-50\/75" : "text-bone-50\/35"/];
    // The website's original globe components, unused since the engine replaced them.
    const skip = new Set(["components/intel/intel-workspace.tsx"]);
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const offenders: string[] = [];
    for (const d of dirs) {
      for (const f of walk(path.join(src, d))) {
        const rel = path.relative(src, f).split(path.sep).join("/");
        if (!/\.tsx?$/.test(f) || skip.has(rel)) continue;
        readFileSync(f, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (allowed.some((a) => a.test(line))) return;
            for (const m of line.matchAll(/text-bone-50\/([0-9]{1,2})(?![0-9])/g)) if (Number(m[1]) < MIN_TEXT_OPACITY * 100) offenders.push(`${rel}:${i + 1} ${m[0]}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("tables are keyboard-scrollable, named regions", () => {
    const ui = readFileSync(path.join(src, "components/platform/ui.tsx"), "utf8");
    expect(ui).toMatch(/<div role="region" aria-label=\{label\} tabIndex=\{0\}/);
    const pages = readdirSync(path.join(src, "app/(platform)"), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".tsx"));
    const unnamed = pages.filter((f) => readFileSync(path.join(src, "app/(platform)", f), "utf8").includes("<Table>"));
    expect(unnamed).toEqual([]);
  });
});
