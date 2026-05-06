// audit-exempt: internal endpoint called by OpenClaw plugin (Smithers), not a user-facing action
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateGatewayToken } from "@/lib/gateway-auth";
import { setSetting } from "@/lib/settings";
import { syncOrgContextToWorkspaces } from "@/lib/context-sync";
import { parseRequestBody } from "@/lib/api-validation";

const internalOrgContextSchema = z.object({ content: z.string() });

export async function PUT(request: NextRequest) {
  if (!validateGatewayToken(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await parseRequestBody(internalOrgContextSchema, request);
  if ("error" in parsed) return parsed.error;
  const { content } = parsed.data;

  await setSetting("org_context", content);
  await syncOrgContextToWorkspaces();

  return NextResponse.json({ success: true, onboardingComplete: true });
}
