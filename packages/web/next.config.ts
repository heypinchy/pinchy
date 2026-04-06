import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { join } from "path";

const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8"));

const nextConfig: NextConfig = {
  devIndicators: false,
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
    ];
  },
};

export default nextConfig;
