// audit-exempt: setIntegrationAuthFailed handles its own audit-on-transition.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateGatewayToken } from "@/lib/gateway-auth";
import { setIntegrationAuthFailed } from "@/lib/integrations/auth-state";
import { parseRequestBody } from "@/lib/api-validation";

const bodySchema = z.object({
  reason: z.string().min(1).max(500),
});

type RouteContext = { params: Promise<{ connectionId: string }> };

export async function POST(request: NextRequest, { params }: RouteContext) {
  if (!validateGatewayToken(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await parseRequestBody(bodySchema, request);
  if ("error" in parsed) return parsed.error;

  const { connectionId } = await params;
  const pluginId = request.headers.get("X-Plugin-Id") ?? "unknown";

  await setIntegrationAuthFailed({
    connectionId,
    reason: parsed.data.reason,
    actor: { type: "system", id: `plugin:${pluginId}` },
  });

  return new NextResponse(null, { status: 204 });
}
