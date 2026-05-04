import { NextResponse } from "next/server";
import { isOpenClawConfigReady } from "@/lib/openclaw-config-ready";

// Intentionally unauthenticated: this is the Docker Compose healthcheck probe.
// It cannot present the gateway token because the OpenClaw container — the
// only consumer of that token — is exactly what this endpoint gates on
// (depends_on: pinchy: condition: service_healthy in docker-compose.yml).
// The response carries one boolean about Pinchy's boot state; no leakage of
// secrets, config, or user data. Listed in PUBLIC_ROUTES of api-auth-check.
export function GET() {
  if (isOpenClawConfigReady()) {
    return NextResponse.json({ ready: true });
  }
  return NextResponse.json({ ready: false }, { status: 503 });
}
