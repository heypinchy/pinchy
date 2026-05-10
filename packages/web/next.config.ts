import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { join } from "path";

const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8"));

const nextConfig: NextConfig = {
  devIndicators: false,
  allowedDevOrigins: ["local.heypinchy.com", "https://local.heypinchy.com:8443"],
  env: {
    NEXT_PUBLIC_PINCHY_VERSION: pkg.version,
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
    ];
  },
};

export default nextConfig;
