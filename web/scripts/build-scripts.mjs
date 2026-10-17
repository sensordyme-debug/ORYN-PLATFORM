/**
 * Bundles the worker and operator CLIs into plain ESM for the production
 * image (dist/*.mjs), so production does not run TypeScript through tsx.
 * Dependencies are bundled (esbuild resolves CommonJS/ESM interop at build
 * time) except those that load files from their own package directory at
 * runtime, which stay external and are installed with `npm ci --omit=dev`.
 *
 *   npm run build:scripts   →  dist/worker.mjs, dist/migrate.mjs, dist/accounts.mjs,
 *                              dist/admin.mjs, dist/verify.mjs
 */
import { build } from "esbuild";

await build({
  entryPoints: {
    worker: "scripts/oryn/worker.ts",
    migrate: "scripts/oryn/migrate.ts",
    accounts: "scripts/oryn/accounts.ts",
    admin: "scripts/oryn/admin.ts",
    verify: "scripts/oryn/verify.ts",
  },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  // pdfkit reads font metrics from its package directory; pg-native is an
  // optional native addon pg probes for; esbuild itself is build-time only.
  external: ["pdfkit", "pg-native", "esbuild"],
  alias: { "server-only": "./scripts/build/server-only-noop.mjs" },
  tsconfig: "tsconfig.json",
  sourcemap: true,
  legalComments: "none",
  // Bundled CommonJS code may use require, __filename, and __dirname, which ES modules lack.
  banner: {
    js: [
      "import { createRequire as __orynRequire } from 'node:module';",
      "import { fileURLToPath as __orynFileUrlToPath } from 'node:url';",
      "import { dirname as __orynDirname } from 'node:path';",
      "const require = __orynRequire(import.meta.url);",
      "const __filename = __orynFileUrlToPath(import.meta.url);",
      "const __dirname = __orynDirname(__filename);",
    ].join(" "),
  },
  logLevel: "info",
});
