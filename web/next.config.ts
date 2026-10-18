import type { NextConfig } from "next";
import { ENGINE_API_PREFIXES, ENGINE_BASE_PATH } from "./src/lib/intel/engine";

/**
 * The geospatial engine (God's Eye View, the root of this repository) runs as
 * its own Node service bound to the loopback interface. ORYN forwards its
 * document, assets and public-data proxies so the browser sees one origin.
 * src/proxy.ts admits these requests only with a valid ORYN session.
 */
const ENGINE_URL = (process.env.ORYN_ENGINE_URL || "http://127.0.0.1:5180").replace(/\/+$/, "");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
  ...(process.env.NODE_ENV === "production" ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
];

const nextConfig: NextConfig = {
  // The container image (Dockerfile) builds a self-contained server
  // (.next/standalone/server.js). Local `npm run build && npm run start` is unchanged.
  ...(process.env.ORYN_STANDALONE_BUILD === "1"
    ? {
        output: "standalone" as const,
        // Image builds start from a clean layer and never reuse .next/cache;
        // writing Turbopack's build cache there only costs time (per the Next.js docs).
        experimental: { turbopackFileSystemCacheForBuild: false },
      }
    : {}),
  poweredByHeader: false,
  reactStrictMode: true,
  // Extra hostnames allowed to load the development server (e.g. a tunnel
  // address), comma-separated in ORYN_DEV_ORIGINS. Unset: localhost only.
  ...(process.env.ORYN_DEV_ORIGINS
    ? { allowedDevOrigins: process.env.ORYN_DEV_ORIGINS.split(",").map((h) => h.trim()).filter(Boolean) }
    : {}),
  // pdfkit reads its font metrics from disk; keep it (and the Postgres
  // drivers) out of the server bundle.
  serverExternalPackages: ["pdfkit", "postgres", "pg"],
  images: {
    formats: ["image/avif", "image/webp"],
    deviceSizes: [640, 828, 1080, 1280, 1600, 1920, 2560],
    imageSizes: [96, 160, 256, 384, 512],
    qualities: [70, 75, 80, 85],
  },
  async rewrites() {
    return {
      beforeFiles: [
        { source: `${ENGINE_BASE_PATH}:path*`, destination: `${ENGINE_URL}${ENGINE_BASE_PATH}:path*` },
        ...ENGINE_API_PREFIXES.map((prefix) => ({ source: `/api/${prefix}/:path*`, destination: `${ENGINE_URL}/api/${prefix}/:path*` })),
      ],
      afterFiles: [],
      fallback: [],
    };
  },
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "private, no-store" }],
      },
      {
        source: "/media/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

export default nextConfig;
