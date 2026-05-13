// auth-direct: public version endpoint — no auth, no PII. Mirrors /api/health's
// exemption from Domain Lock so monitoring tools and upgrade verification work
// from any host (see server/host-check.ts EXEMPT_PATHS).
import { NextResponse } from "next/server";

export async function GET() {
  const sha = process.env.PINCHY_BUILD_SHA;
  const body = {
    pinchyVersion: process.env.NEXT_PUBLIC_PINCHY_VERSION ?? "unknown",
    openclawVersion: process.env.NEXT_PUBLIC_OPENCLAW_VERSION ?? "unknown",
    build: sha ? sha.slice(0, 12) : "dev",
    nodeEnv: process.env.NODE_ENV ?? "unknown",
  };
  return NextResponse.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}
