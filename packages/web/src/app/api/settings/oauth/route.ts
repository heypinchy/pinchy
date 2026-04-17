import { NextRequest, NextResponse, after } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import {
  getOAuthSettings,
  saveOAuthSettings,
  GOOGLE_OAUTH_SETTINGS_KEY,
} from "@/lib/integrations/oauth-settings";
import { appendAuditLog } from "@/lib/audit";

const SUPPORTED_PROVIDERS = ["google"] as const;
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

function isSupportedProvider(value: unknown): value is SupportedProvider {
  return typeof value === "string" && SUPPORTED_PROVIDERS.includes(value as SupportedProvider);
}

export async function GET(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const provider = request.nextUrl.searchParams.get("provider");
  if (!provider || !isSupportedProvider(provider)) {
    return NextResponse.json({ error: "Invalid or missing provider" }, { status: 400 });
  }

  const settings = await getOAuthSettings(provider);
  if (!settings) {
    return NextResponse.json({ configured: false, clientId: "" });
  }

  return NextResponse.json({
    configured: true,
    clientId: settings.clientId,
  });
}

export async function POST(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const body = await request.json();
  const { provider, clientId, clientSecret } = body;

  if (!provider || !isSupportedProvider(provider)) {
    return NextResponse.json({ error: "Invalid or missing provider" }, { status: 400 });
  }

  if (!clientId || typeof clientId !== "string") {
    return NextResponse.json({ error: "Client ID is required" }, { status: 400 });
  }

  if (!clientSecret || typeof clientSecret !== "string") {
    return NextResponse.json({ error: "Client Secret is required" }, { status: 400 });
  }

  await saveOAuthSettings(provider, { clientId, clientSecret });

  after(() =>
    appendAuditLog({
      actorType: "user",
      actorId: sessionOrError.user.id!,
      eventType: "config.changed",
      detail: { key: GOOGLE_OAUTH_SETTINGS_KEY, provider },
      outcome: "success",
    })
  );

  return NextResponse.json({ success: true });
}
