import { NextResponse } from "next/server";
import { getSecretsProvenance } from "@/lib/secret-source";
import { openClawConnectionState } from "@/server/openclaw-connection-state";
import { getConfigRegenState } from "@/lib/openclaw-config-health";

export async function GET() {
  return NextResponse.json({
    // Issue #651: `status` deliberately does NOT reflect OpenClaw gateway
    // connectivity. Brief disconnects during config.apply-triggered OpenClaw
    // restarts are expected and self-heal; flipping `status` here would make
    // the Docker healthcheck restart-loop the container during normal
    // operation. Use `openclaw.connected` below (or `/api/health/openclaw`)
    // to monitor gateway reachability separately.
    status: "ok",
    // Issue #156: provenance only ("envvar" | "file" | "unset" /
    // "custom" | "default") — never secret values. Lets operators see from
    // the shell whether the file fallback is active before rotating
    // anything (rotating an auto-generated encryption key loses data).
    secrets: getSecretsProvenance(),
    // Issue #651: during the 2026-07-02 staging incident, the OpenClaw
    // gateway client was dead while this endpoint still reported "ok" —
    // chat was completely unavailable but no monitor could see it. Surface
    // the gateway connection state so uptime checks catch this class of
    // failure even though top-level `status` intentionally stays "ok".
    openclaw: {
      connected: openClawConnectionState.connected,
    },
    // Issue #879: the boot-time config regeneration can throw (e.g. the #878
    // missing-secrets-volume EACCES) while readiness is still marked so
    // OpenClaw can start — top-level `status` stays "ok" for the same reason it
    // does for gateway disconnects. Surface the regeneration outcome here so
    // monitoring and the admin UI can catch a frozen config even though the
    // instance otherwise reports healthy. `error` is operator-facing guidance
    // only — never secret material.
    configRegeneration: getConfigRegenState(),
  });
}
