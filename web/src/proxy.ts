import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { CAMERA_PROVIDERS } from "@/lib/intel/cameras";

/**
 * Runs before platform and auth pages:
 *  1. Optimistic auth redirect for /app — a missing session cookie goes
 *     straight to sign-in. This is only a UX shortcut; every page, action,
 *     and API route still verifies the session and permissions on the server.
 *  2. A per-request nonce-based Content Security Policy for the platform.
 *     Marketing pages are static and keep the global headers from
 *     next.config.ts.
 */

const TILE_HOSTS = [
  "https://basemap.nationalmap.gov",
  "https://hazards.fema.gov",
  "https://tiles.openfreemap.org",
  // NASA GIBS imagery for the 3D intelligence globe (Blue Marble, VIIRS daily).
  "https://gibs.earthdata.nasa.gov",
].join(" ");

// Public camera stills and live HLS video, loaded by the browser directly from the operator (never relayed by ORYN).
const CAMERA_HOSTS = [...new Set(Object.values(CAMERA_PROVIDERS).flatMap((p) => p.mediaHosts))].join(" ");

/**
 * The 3D intelligence globe (CesiumJS) compiles WebAssembly decoders (e.g. the
 * bundled meshoptimizer). 'wasm-unsafe-eval' allows WebAssembly compilation
 * only — not JavaScript eval — and only on that page.
 */
const WASM_PAGES = /^\/app\/[^/]+\/intel(\/|$)/;

export function csp(nonce: string, opts: { wasm?: boolean } = {}): string {
  const dev = process.env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${opts.wasm ? " 'wasm-unsafe-eval'" : ""}${dev ? " 'unsafe-eval'" : ""}`,
    // Inline style attributes are required by React style props and MapLibre.
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' blob: data: ${TILE_HOSTS} ${CAMERA_HOSTS}`,
    `connect-src 'self' ${TILE_HOSTS} ${CAMERA_HOSTS}${dev ? " ws:" : ""}`,
    // hls.js plays through Media Source Extensions (blob: URLs); Safari plays HLS natively from the host.
    `media-src 'self' blob: ${CAMERA_HOSTS}`,
    "worker-src 'self' blob:",
    "child-src blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (pathname === "/app" || pathname.startsWith("/app/")) {
    if (!getSessionCookie(request, { cookiePrefix: "oryn" })) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.search = `?next=${encodeURIComponent(pathname + search)}`;
      return NextResponse.redirect(url);
    }
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = csp(nonce, { wasm: WASM_PAGES.test(pathname) });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: [
    {
      source: "/(app|login|invite|forgot-password|reset-password)(.*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
