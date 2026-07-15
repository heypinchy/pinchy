import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { join } from "path";

const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8"));
const openclawVersion: string =
  pkg.devDependencies?.openclaw ?? pkg.dependencies?.openclaw ?? "unknown";

const nextConfig: NextConfig = {
  devIndicators: false,
  // pdfjs-dist must NOT be bundled: its Node fallback ("fake worker") loads
  // pdf.worker.mjs via a runtime dynamic import that the bundler cannot see,
  // so bundling breaks the KB ingest's PDF extraction at runtime with
  // "Cannot find module '…/chunks/pdf.worker.mjs'" (found in the Phase-1
  // live verify — unit tests run unbundled and can't catch this). External =
  // resolved from node_modules at runtime, where the worker file exists.
  // node-llama-cpp ships a native .node addon and is itself ESM-only; it must
  // be resolved from node_modules at runtime via dynamic import, not bundled
  // — same class of reason as pdfjs-dist above (bundling breaks native/worker
  // resolution the bundler can't statically see).
  serverExternalPackages: ["pdfjs-dist", "node-llama-cpp"],
  allowedDevOrigins: ["local.heypinchy.com", "https://local.heypinchy.com:8443"],
  env: {
    NEXT_PUBLIC_PINCHY_VERSION: pkg.version,
    NEXT_PUBLIC_OPENCLAW_VERSION: openclawVersion,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          // HSTS is handled by the reverse proxy (Caddy/nginx/Traefik).
          // Setting it here would require runtime DB access which next.config doesn't support.
        ],
      },
      {
        // The uploads API serves files that are embedded inline via <embed> and
        // <img> in AttachmentPreview. The global DENY rule above would block the
        // browser's PDF/image viewer from rendering them, so we relax to
        // SAMEORIGIN here. Same-origin only — cross-origin embedding is still
        // blocked. This rule comes after the catch-all so it takes precedence.
        source: "/api/agents/:agentId/uploads/:filename",
        headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }],
      },
      {
        // Service worker must not be long-cached, otherwise future SW updates
        // never reach users. Same pattern as other PWAs (Slack, Mattermost).
        source: "/sw.js",
        headers: [{ key: "Cache-Control", value: "no-cache, max-age=0, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
