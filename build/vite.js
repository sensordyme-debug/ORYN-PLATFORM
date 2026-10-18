import { rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { applicationHtmlPlugin } from './application-html.js';
import cesium from 'vite-plugin-cesium';
import { DEFAULT_ALLOWED_HOSTS, hostCheckPlugin } from './allowedHosts.js';
import { embedFramingPlugin } from './embed-framing.js';
import { panelBuildPlugin } from './panel.js';
import { noncommercialExclusionPlugin } from './noncommercial.js';

/**
 * Content-Security-Policy for every document the dev/preview server serves.
 * No inline script is permitted, and the only foreign script origins are the
 * three that the Bhote Koshi event's embedded media needs (YouTube, Facebook
 * and X), which frame-src matches for their players and posts. 'unsafe-eval' is
 * required: Knockout (bundled inside @cesium/widgets) resolves the global
 * object with `(0, eval)("this")` at module load, and without it the Cesium
 * widget never initializes (verified in headless Chrome). It also covers
 * Cesium's WASM decoders. `blob:` is required in the built app: Cesium's
 * bundled workers bootstrap through `importScripts(blob:...)`, which a worker
 * checks against script-src (the dev server loads them by URL instead).
 * Widen any other directive only for a real violation.
 */
export const BROWSER_CSP = [
  "default-src 'self'",
  // The Bhote Koshi event's embedded media: the YouTube player API, the
  // Facebook video SDK and X's post widget (src/data/bhoteKoshiEmbeddedMedia.js);
  // and the Maps JavaScript API that Street Level's Google Street View runs on.
  "script-src 'self' 'unsafe-eval' blob: https://www.youtube.com https://connect.facebook.net https://platform.twitter.com https://maps.googleapis.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self' blob: data: https: wss: ws:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  // The same media's players and posts, which load in frames.
  "frame-src 'self' blob: https://www.youtube-nocookie.com https://www.youtube.com https://www.facebook.com https://platform.twitter.com",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Response headers shared by the dev and preview servers. */
export const BROWSER_HEADERS = Object.freeze({
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': BROWSER_CSP,
  // Responses are only ever used as the type the server declares.
  'X-Content-Type-Options': 'nosniff',
});

/**
 * A Vite base path: `/` by default, otherwise `/segment/.../`. Anything
 * that is not a plain absolute path of URL-safe segments is refused, so a
 * mistyped variable can never point asset URLs at another origin.
 */
export function normalizeBasePath(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw === '/') return '/';
  const trimmed = `/${raw.replace(/^\/+|\/+$/g, '')}/`;
  const segments = trimmed.split('/').filter(Boolean);
  if (
    !/^\/(?:[A-Za-z0-9._-]+\/)+$/.test(trimmed) ||
    segments.some((segment) => segment === '.' || segment === '..')
  )
    throw new Error(`Invalid GEV_BASE_PATH: ${raw}`);
  return trimmed;
}

/**
 * vite-plugin-cesium copies Cesium's static files to `outDir + base +
 * cesium/` while the page requests `base + cesium/`, which the server maps to
 * `outDir/cesium/`. Under a non-root base the two disagree, so move the copy
 * to where the page looks for it. A root base needs nothing.
 */
export function cesiumBasePathPlugin(base = '/') {
  let outDir = 'dist';
  return {
    name: 'cesium-base-path',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle: {
      order: 'post',
      sequential: true,
      async handler() {
        if (base === '/') return;
        const nested = path.join(outDir, ...base.split('/').filter(Boolean));
        const from = path.join(nested, 'cesium');
        const to = path.join(outDir, 'cesium');
        try {
          await stat(from);
        } catch {
          return;
        }
        await rm(to, { recursive: true, force: true });
        await rename(from, to);
        await rm(nested, { recursive: true, force: true });
      },
    },
  };
}

/** Build browser assets with explicit inputs; never load environment or providers. */
export function createBrowserViteConfig({
  plugins = [],
  publicDir,
  googleApiKey,
  cesiumToken,
  mapillaryToken,
  host = 'localhost',
  port = 4173,
  allowedHosts = DEFAULT_ALLOWED_HOSTS,
  command,
  base,
  excludeNoncommercial = false,
  hostAllLayers = false,
} = {}) {
  const basePath = normalizeBasePath(base);
  return {
    // A host application can serve the engine under a sub-path
    // (GEV_BASE_PATH=/engine/) so it shares that application's origin.
    ...(basePath === '/' ? {} : { base: basePath }),
    plugins: [
      // First, so no provider route answers a Host the server does not allow.
      hostCheckPlugin(),
      cesium(),
      applicationHtmlPlugin(),
      ...plugins,
      embedFramingPlugin({ base: basePath }),
      panelBuildPlugin(),
      // Only a sub-path deployment needs Cesium's static copy relocated.
      ...(basePath === '/' ? [] : [cesiumBasePathPlugin(basePath)]),
      // A commercial build drops the non-commercially licensed datasets.
      ...(excludeNoncommercial ? [noncommercialExclusionPlugin()] : []),
    ],
    ...(publicDir === undefined ? {} : { publicDir }),
    // A production build must not clean the dependency cache a running dev
    // server is still serving optimized module URLs from.
    ...(command === 'build' ? { cacheDir: 'node_modules/.vite-build' } : {}),
    optimizeDeps: {
      // First reached through the SDR worker or a dynamic import. Pre-bundle
      // them at startup so first use cannot invalidate already-transformed
      // URLs with Vite's "Outdated Optimize Dep" 504 response.
      include: [
        '@jtarrio/signals/demod/demodulator.js',
        '@jtarrio/signals/demod/modes.js',
        '@jtarrio/webrtlsdr/rtlsdr.js',
        'egm96-universal',
        // Loaded on demand when the first street-level image opens.
        'mapillary-js',
      ],
    },
    server: {
      host: host || 'localhost',
      port: parseInt(port, 10) || 4173,
      // A wildcard bind only chooses interfaces; it never disables Vite's
      // Host-header check. LAN hostnames are added explicitly (see
      // build/allowedHosts.js); IP addresses are always accepted.
      allowedHosts: [...allowedHosts],
      fs: {
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/ENVIRONMENT'],
      },
      // Build output and the ORYN web application (its own toolchain and
      // .next cache) are not engine sources; watching them only invites
      // locked-file errors on Windows.
      watch: {
        ignored: ['**/dist-engine/**', '**/dist-engine-all/**', '**/web/**'],
      },
      // These headers protect the document containing Provider Settings and
      // give the whole page a real Content-Security-Policy (BROWSER_CSP).
      // Embed-mode documents are framable instead: embed-framing.js rewrites
      // only the frame-ancestors directive and keeps the rest of the policy.
      headers: BROWSER_HEADERS,
    },
    // The preview server serves the same documents, so it carries the same
    // framing + CSP hardening (one constant, no drift).
    preview: { headers: BROWSER_HEADERS },
    define: {
      'import.meta.env.GOOGLE_MAPS_API_KEY': JSON.stringify(googleApiKey),
      'import.meta.env.CESIUM_ION_TOKEN': JSON.stringify(cesiumToken),
      // Mapillary client tokens are public by design (see SECURITY.md).
      'import.meta.env.MAPILLARY_CLIENT_TOKEN': JSON.stringify(
        mapillaryToken ?? '',
      ),
      // Development host builds offer every layer (src/ui/host/hostLicences.js).
      'import.meta.env.GEV_HOST_ALL_LAYERS': JSON.stringify(hostAllLayers),
    },
    build: { chunkSizeWarningLimit: 1500 },
  };
}
