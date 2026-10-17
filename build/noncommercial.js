import { rmSync } from 'node:fs';
import path from 'node:path';

/**
 * Datasets this repository bundles under NON-COMMERCIAL licences (see LICENSE
 * and DATA_SOURCES.md). A commercial build (GEV_EXCLUDE_NONCOMMERCIAL=1, set
 * by scripts/oryn-engine.mjs) must not ship them:
 *
 *   - TeleGeography Submarine Cable Map, CC BY-NC-SA 3.0
 *     (src/data/local_data/telegeography_submarine_cables/, read through
 *     bundledSource.js, which emits the JSON files as assets);
 *   - the Bhote Koshi event pack, CC BY-NC 4.0: public/events/bhote-koshi-2026/
 *     (imagery and event.json), the derived river centerline compiled into
 *     bhoteKoshiFloodPath.js, and the evidence-record coordinates in
 *     bhoteKoshiIncidentPlaces.js.
 *
 * Each module is replaced by an empty stand-in with the same exports, so the
 * application still builds; the layers that used them have nothing to show
 * and a host withholds them (src/ui/host/hostLicences.js).
 */
export const NONCOMMERCIAL_MODULE_STUBS = Object.freeze({
  'src/data/bhoteKoshiFloodPath.js':
    '// Withheld: CC BY-NC 4.0 dataset excluded from this build.\nexport const BHOTE_KOSHI_FLOOD_PATH = Object.freeze([]);\n',
  'src/data/bhoteKoshiIncidentPlaces.js':
    '// Withheld: CC BY-NC 4.0 dataset excluded from this build.\nexport const INCIDENT_OVERVIEW_PLACES = Object.freeze([]);\nexport const INCIDENT_OVERVIEW_HOLD_SEC = 11;\n',
  'src/layers/submarineCables/bundledSource.js': [
    '// Withheld: TeleGeography data (CC BY-NC-SA 3.0) excluded from this build.',
    'export function createBundledCableSource() {',
    '  return {',
    "    label: 'TeleGeography',",
    '    async fetch() {',
    "      throw new Error('Submarine cable data is not included in this build (non-commercial licence).');",
    '    },',
    '  };',
    '}',
    '',
  ].join('\n'),
});

/**
 * Restricted values embedded in otherwise-kept modules, replaced in place.
 * Each search must match exactly once, so a changed source fails the build
 * instead of shipping the data.
 */
export const NONCOMMERCIAL_REPLACEMENTS = Object.freeze({
  // The incident point is the first evidence record of the event pack.
  'src/data/bhoteKoshiLocator.js': Object.freeze([
    ['lat: 28.3632333,\n  lon: 85.4423639,', 'lat: 0,\n  lon: 0,'],
  ]),
});

/** Apply NONCOMMERCIAL_REPLACEMENTS to one module's source. */
export function applyNoncommercialReplacements(code, replacements, file) {
  let out = code.replace(/\r\n/g, '\n');
  for (const [search, replacement] of replacements) {
    const count = out.split(search).length - 1;
    if (count !== 1)
      throw new Error(
        `${file}: expected one match for a non-commercial value, found ${count}`,
      );
    out = out.replace(search, replacement);
  }
  return out;
}

/** Public-directory paths (relative to the output directory) removed from a commercial build. */
export const NONCOMMERCIAL_PUBLIC_PATHS = Object.freeze([
  'events/bhote-koshi-2026',
]);

const normalize = (file) =>
  path.resolve(file).replace(/\\/g, '/').toLowerCase();

/** Vite plugin that replaces the modules above and drops the public files. */
export function noncommercialExclusionPlugin({ root = process.cwd() } = {}) {
  const stubs = new Map(
    Object.entries(NONCOMMERCIAL_MODULE_STUBS).map(([file, code]) => [
      normalize(path.join(root, file)),
      code,
    ]),
  );
  const replacements = new Map(
    Object.entries(NONCOMMERCIAL_REPLACEMENTS).map(([file, list]) => [
      normalize(path.join(root, file)),
      { file, list },
    ]),
  );
  let outDir = null;
  return {
    name: 'exclude-noncommercial-data',
    enforce: 'pre',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    load(id) {
      return stubs.get(normalize(id.split('?')[0])) ?? null;
    },
    transform(code, id) {
      const entry = replacements.get(normalize(id.split('?')[0]));
      if (!entry) return null;
      return {
        code: applyNoncommercialReplacements(code, entry.list, entry.file),
        map: null,
      };
    },
    closeBundle() {
      if (!outDir) return;
      for (const relative of NONCOMMERCIAL_PUBLIC_PATHS) {
        rmSync(path.join(outDir, relative), { recursive: true, force: true });
      }
    },
  };
}
