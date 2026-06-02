// audit-exempt: setIntegrationAuthFailed handles its own audit-on-transition.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateGatewayToken } from "@/lib/gateway-auth";
import { setIntegrationAuthFailed } from "@/lib/integrations/auth-state";
import { parseRequestBody } from "@/lib/api-validation";
import { KNOWN_PINCHY_PLUGINS } from "@/lib/openclaw-config/plugin-manifest-loader";

const bodySchema = z.object({
  reason: z.string().min(1).max(500),
});

// All Pinchy plugins share the same bootstrap gateway token (Pattern C in
// AGENTS.md), so the header alone cannot prove which plugin is calling. We
// allowlist X-Plugin-Id against the known Pinchy-plugin set so a buggy or
// impersonating caller cannot record audit transitions under an arbitrary
// actor name.
const KNOWN_PLUGIN_IDS: ReadonlySet<string> = new Set(KNOWN_PINCHY_PLUGINS);

type RouteContext = { params: Promise<{ connectionId: string }> };

export async function POST(request: NextRequest, { params }: RouteContext) {
  if (!validateGatewayToken(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pluginId = request.headers.get("X-Plugin-Id");
  if (!pluginId || !KNOWN_PLUGIN_IDS.has(pluginId)) {
    return NextResponse.json({ error: "Missing or unknown X-Plugin-Id header" }, { status: 400 });
  }

  const parsed = await parseRequestBody(bodySchema, request);
  if ("error" in parsed) return parsed.error;

  const { connectionId } = await params;

  await setIntegrationAuthFailed({
    connectionId,
    reason: parsed.data.reason,
    actor: { type: "system", id: `plugin:${pluginId}` },
  });

  return new NextResponse(null, { status: 204 });
}
