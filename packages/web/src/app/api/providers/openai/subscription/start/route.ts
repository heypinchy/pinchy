import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { createAuthorizationRequest } from "@pinchy/openai-subscription-oauth";
import {
  createPendingFlow,
  OPENAI_CODEX_CLIENT_ID,
  OPENAI_CODEX_SCOPE,
  OPENAI_CODEX_DEVICE_CODE_URL,
} from "@/lib/openai-oauth-state";
import { appendAuditLog } from "@/lib/audit";

export async function POST() {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;

  try {
    const request = await createAuthorizationRequest({
      clientId: OPENAI_CODEX_CLIENT_ID,
      scope: OPENAI_CODEX_SCOPE,
      endpoint: OPENAI_CODEX_DEVICE_CODE_URL,
    });

    const flowId = createPendingFlow({
      deviceCode: request.deviceCode,
      clientId: OPENAI_CODEX_CLIENT_ID,
      interval: request.interval,
      expiresAt: Date.now() + request.expiresIn * 1000,
    });

    return NextResponse.json({
      flowId,
      userCode: request.userCode,
      verificationUri: request.verificationUri,
      verificationUriComplete: request.verificationUriComplete,
      interval: request.interval,
      expiresIn: request.expiresIn,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await appendAuditLog({
      actorType: "user",
      actorId: session.user.id,
      eventType: "config.changed",
      resource: "settings:openai_subscription",
      outcome: "failure",
      error: { message },
      detail: { event: "subscription_start_failed" },
    });
    return NextResponse.json({ error: "Failed to start device flow" }, { status: 500 });
  }
}
