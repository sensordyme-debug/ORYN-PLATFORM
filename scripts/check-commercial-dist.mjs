#!/usr/bin/env node
/**
 * Verify that a commercial engine build (GEV_EXCLUDE_NONCOMMERCIAL=1) contains
 * none of the non-commercially licensed datasets listed in
 * build/noncommercial.js, and that it carries the licence texts the MIT and
 * Apache-2.0 licences require.
 *
 *   node scripts/check-commercial-dist.mjs [outDir]     (default dist-engine)
 *
 * Fingerprints are read from the source datasets themselves, so a renamed or
 * re-bundled copy is still found. Exits 1 with the findings on any violation.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Distinctive strings that only the restricted datasets contain. */
export function restrictedFingerprints(sourceRoot = root) {
  const prints = [];
  const cables = path.join(
    sourceRoot,
    'src/data/local_data/telegeography_submarine_cables/cable-geo.json',
  );
  if (existsSync(cables)) {
    const json = JSON.parse(readFileSync(cables, 'utf8'));
    for (const feature of json.features.slice(0, 3))
      prints.push({
        dataset: 'TeleGeography cables',
        text: feature.properties.feature_id,
      });
  }
  const floodPath = path.join(sourceRoot, 'src/data/bhoteKoshiFloodPath.js');
  if (existsSync(floodPath)) {
    const match = readFileSync(floodPath, 'utf8').match(
      /\[(\d+\.\d{4,}),\s*(\d+\.\d{4,})\]/,
    );
    if (match)
      prints.push({ dataset: 'Bhote Koshi flood path', text: match[1] });
  }
  const places = path.join(sourceRoot, 'src/data/bhoteKoshiIncidentPlaces.js');
  if (existsSync(places)) {
    const match = readFileSync(places, 'utf8').match(/(\d+\.\d{6,})/);
    if (match)
      prints.push({ dataset: 'Bhote Koshi incident places', text: match[1] });
  }
  return prints;
}

const RESTRICTED_PATHS =
  /telegeography|cable-geo|landing-point-geo|bhote-koshi-2026|event\.json$|(^|\/)pre\.webp$|(^|\/)post\.webp$/i;
const TEXT_FILE = /\.(js|mjs|json|html|css|txt|svg|webmanifest)$/i;
const REQUIRED_NOTICES = ['LICENSE.txt', 'licenses/cesium-LICENSE.md'];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

export function checkCommercialDist(outDir, { sourceRoot = root } = {}) {
  const findings = [];
  if (!existsSync(path.join(outDir, 'index.html')))
    return [`${outDir} is not a build output (no index.html)`];
  const prints = restrictedFingerprints(sourceRoot);
  for (const file of walk(outDir)) {
    const relative = path.relative(outDir, file).replace(/\\/g, '/');
    if (RESTRICTED_PATHS.test(relative))
      findings.push(`restricted file shipped: ${relative}`);
    if (!TEXT_FILE.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const print of prints)
      if (text.includes(print.text))
        findings.push(
          `${print.dataset} data found in ${relative} ("${print.text}")`,
        );
  }
  for (const notice of REQUIRED_NOTICES)
    if (!existsSync(path.join(outDir, notice)))
      findings.push(`licence notice missing: ${notice}`);
  return findings;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const outDir = path.resolve(root, process.argv[2] || 'dist-engine');
  const findings = checkCommercialDist(outDir);
  if (findings.length) {
    console.error(
      `[commercial-dist] ${findings.length} problem(s) in ${outDir}:`,
    );
    for (const f of findings) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(
    `[commercial-dist] ${outDir}: no non-commercial datasets; licence notices present`,
  );
}
