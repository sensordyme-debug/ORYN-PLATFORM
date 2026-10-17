// Copies browser assets that must be served as standalone files (not bundled)
// into public/vendor. Runs before `dev` and `build`; the output is gitignored.
//  - MapLibre GL's web worker: MapLibre derives the worker URL from its own
//    module URL, which no longer holds once the library is bundled.
//  - CesiumJS engine workers, third-party decoders, and assets: Cesium loads
//    them at runtime from CESIUM_BASE_URL (/vendor/cesium-<version>/). They
//    come from the same @cesium/engine build the app bundles, so code and
//    workers never drift apart.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, "node_modules/maplibre-gl/package.json"), "utf8"));
const outDir = path.join(root, "public/vendor/maplibre");
mkdirSync(outDir, { recursive: true });
copyFileSync(path.join(root, "node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs"), path.join(outDir, `maplibre-gl-worker-${pkg.version}.mjs`));
console.log(`vendor: maplibre-gl-worker-${pkg.version}.mjs`);

const cesium = JSON.parse(readFileSync(path.join(root, "node_modules/@cesium/engine/package.json"), "utf8"));
const cesiumOut = path.join(root, `public/vendor/cesium-${cesium.version}`);
if (!existsSync(path.join(cesiumOut, "Workers"))) {
  const engine = path.join(root, "node_modules/@cesium/engine");
  for (const dir of ["Workers", "ThirdParty", "Assets"]) {
    // Assets moved from Source/ to Build/ in later engine releases.
    const from = [path.join(engine, "Build", dir), path.join(engine, "Source", dir)].find((p) => existsSync(p));
    if (!from) throw new Error(`@cesium/engine: ${dir} not found`);
    cpSync(from, path.join(cesiumOut, dir), { recursive: true });
  }
  // Apache-2.0: the licence (with Cesium's third-party notices) travels with the served files.
  copyFileSync(path.join(engine, "LICENSE.md"), path.join(cesiumOut, "LICENSE.md"));
}
console.log(`vendor: cesium-${cesium.version}/{Workers,ThirdParty,Assets}`);
