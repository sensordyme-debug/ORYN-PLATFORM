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
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const port = String(Number.parseInt(flag('--port', '5180'), 10) || 5180);
const outDir = 'dist-engine';
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const env = {
  ...process.env,
  GEV_BASE_PATH: '/engine/',
  GEV_EMBED_FRAME_ANCESTORS: "'self'",
};

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

if (args.includes('--build') || !existsSync(path.join(root, outDir, 'index.html'))) {
  console.log(`[oryn-engine] building the engine under /engine/ into ${outDir}/`);
  await run(['build', '--outDir', outDir]);
}
console.log(`[oryn-engine] serving on http://127.0.0.1:${port}/engine/ (loopback only)`);
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
