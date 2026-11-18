// audit-exempt: internal endpoint called by OpenClaw plugin (Smithers), not a user-facing action
import { NextRequest, NextResponse } from "next/server";
import { validateGatewayToken } from "@/lib/gateway-auth";
import { setSetting } from "@/lib/settings";
import { syncOrgContextToWorkspaces } from "@/lib/context-sync";
import { parseRequestBody } from "@/lib/api-validation";
import { contextContentSchema } from "@/lib/schemas/context";

export async function PUT(request: NextRequest) {
  if (!validateGatewayToken(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await parseRequestBody(contextContentSchema, request);
  if ("error" in parsed) return parsed.error;
  const { content } = parsed.data;

  await setSetting("org_context", content);
  await syncOrgContextToWorkspaces();

  return NextResponse.json({ success: true, onboardingComplete: true });
}
