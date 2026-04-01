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
          // HSTS is only safe when HTTPS is configured. On plain HTTP it
          // tells browsers to refuse future HTTP requests, breaking the app.
          // When running behind a TLS-terminating reverse proxy (Caddy/nginx),
          // the proxy should set this header instead.
          ...(process.env.BETTER_AUTH_URL?.startsWith("https://")
            ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
            : []),
        ],
      },
    ];
  },
};

export default nextConfig;
