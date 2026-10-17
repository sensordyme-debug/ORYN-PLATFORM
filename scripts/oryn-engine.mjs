#!/usr/bin/env node
/**
 * Serve this engine for the ORYN platform.
 *
 * The ORYN web application frames the engine same-origin: it forwards
 * /engine/* and the engine's public-data /api routes to this server (see
 * ORYN_INTEGRATION_PLAN.md). This script builds the engine under the
 * /engine/ base path and runs Vite's preview server, which carries every
 * provider proxy, on the loopback interface only. Engine documents opened
 * with ?host=oryn may be framed by their own origin and by nothing else.
 *
 *   npm run oryn:engine                 build if needed, then serve on :5180
 *   npm run oryn:engine -- --build      force a rebuild first
 *   npm run oryn:engine -- --port 5190  another port (set ORYN_ENGINE_URL to match)
 *
 * ORYN is a commercial product, so this build and server are licence-clean
 * (see ORYN_LICENCE_REVIEW.md and src/ui/host/hostLicences.js):
 *   - non-commercially licensed datasets are left out of the build
 *     (GEV_EXCLUDE_NONCOMMERCIAL, build/noncommercial.js) and the output is
 *     checked by scripts/check-commercial-dist.mjs, which also requires the
 *     engine's MIT notice and Cesium's Apache-2.0 licence to be present;
 *   - flights come from adsb.lol only (OpenSky is non-commercial);
 *   - only camera operators whose image licences were verified are loaded;
 *   - keys for paid services are cleared, so nothing paid is ever called.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_CCTV_PACKS } from '../src/ui/host/hostLicences.js';
import { checkCommercialDist } from './check-commercial-dist.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const port = String(Number.parseInt(flag('--port', '5180'), 10) || 5180);
const outDir = 'dist-engine';
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
/** Paid or non-commercial services ORYN never uses, whatever a local .env says. */
const CLEARED_KEYS = [
  'GOOGLE_MAPS_API_KEY',
  'GOOGLE_MAPS_SERVER_API_KEY',
  'CESIUM_ION_TOKEN',
  'TOMTOM_API_KEY',
  'OPENAI_API_KEY',
  'MAPILLARY_CLIENT_TOKEN',
  'OPENSKY_CLIENT_ID',
  'OPENSKY_CLIENT_SECRET',
  'OPENSKY_USERNAME',
  'OPENSKY_PASSWORD',
  'AISSTREAM_API_KEY',
];
const env = {
  ...process.env,
  ...Object.fromEntries(CLEARED_KEYS.map((key) => [key, ''])),
  GEV_BASE_PATH: '/engine/',
  GEV_EMBED_FRAME_ANCESTORS: "'self'",
  GEV_EXCLUDE_NONCOMMERCIAL: '1',
  GEV_FLIGHTS_SOURCE: 'adsb-lol',
  CCTV_PACKS: HOST_CCTV_PACKS.oryn.join(','),
  // DriveBC partner cameras belong to third parties; keep ministry ones.
  CCTV_DRIVEBC_MINISTRY_ONLY: '1',
  // The shipped camera ground heights were sampled from Google 3D Tiles.
  CCTV_GROUND_HEIGHTS_FILE: 'off',
};

/** Ship the licence texts the MIT and Apache-2.0 licences require. */
function addLicenceNotices() {
  const out = path.join(root, outDir);
  copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE.txt'));
  mkdirSync(path.join(out, 'licenses'), { recursive: true });
  copyFileSync(
    path.join(root, 'node_modules', 'cesium', 'LICENSE.md'),
    path.join(out, 'licenses', 'cesium-LICENSE.md'),
  );
}

function run(viteArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [vite, ...viteArgs], {
      cwd: root,
      env,
      stdio: 'inherit',
    });
    const stop = () => child.kill('SIGTERM');
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    child.on('exit', (code) => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      if (code === 0 || code === null) resolve();
      else reject(new Error(`vite ${viteArgs[0]} exited with ${code}`));
    });
  });
}

const distProblems = () => checkCommercialDist(path.join(root, outDir));
if (args.includes('--build') || distProblems().length) {
  console.log(
    `[oryn-engine] building the engine under /engine/ into ${outDir}/`,
  );
  await run(['build', '--outDir', outDir]);
  addLicenceNotices();
  const problems = distProblems();
  if (problems.length) {
    console.error('[oryn-engine] the build is not licence-clean:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(
    '[oryn-engine] build checked: no non-commercial datasets; licence notices present',
  );
}
console.log(
  `[oryn-engine] serving on http://127.0.0.1:${port}/engine/ (loopback only)`,
);
await run([
  'preview',
  '--outDir',
  outDir,
  '--port',
  port,
  '--strictPort',
  '--host',
  '127.0.0.1',
]);
