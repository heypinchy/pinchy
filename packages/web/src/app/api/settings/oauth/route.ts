import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/api-auth";
import {
  getOAuthSettings,
  saveOAuthSettings,
  GOOGLE_OAUTH_SETTINGS_KEY,
  MICROSOFT_OAUTH_SETTINGS_KEY,
} from "@/lib/integrations/oauth-settings";
import { appendAuditLog } from "@/lib/audit";
import { parseRequestBody } from "@/lib/api-validation";

const SUPPORTED_PROVIDERS = ["google", "microsoft"] as const;
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

function isSupportedProvider(value: unknown): value is SupportedProvider {
  return typeof value === "string" && SUPPORTED_PROVIDERS.includes(value as SupportedProvider);
}

const saveGoogleOAuthSchema = z.object({
  provider: z.literal("google"),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

const saveMicrosoftOAuthSchema = z.object({
  provider: z.literal("microsoft"),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  tenantId: z.string().min(1).optional(),
});

const saveOAuthSchema = z.discriminatedUnion("provider", [
  saveGoogleOAuthSchema,
  saveMicrosoftOAuthSchema,
]);

const SETTINGS_KEY_MAP: Record<SupportedProvider, string> = {
  google: GOOGLE_OAUTH_SETTINGS_KEY,
  microsoft: MICROSOFT_OAUTH_SETTINGS_KEY,
};

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

  const parsed = await parseRequestBody(saveOAuthSchema, request);
  if ("error" in parsed) return parsed.error;
  const data = parsed.data;

  if (data.provider === "microsoft") {
    const { clientId, clientSecret, tenantId } = data;
    const settingsToSave = tenantId
      ? { clientId, clientSecret, tenantId }
      : { clientId, clientSecret };
    await saveOAuthSettings("microsoft", settingsToSave);

    after(() =>
      appendAuditLog({
        actorType: "user",
        actorId: sessionOrError.user.id!,
        eventType: "config.changed",
        detail: { key: SETTINGS_KEY_MAP["microsoft"], provider: "microsoft" },
        outcome: "success",
      })
    );
  } else {
    const { clientId, clientSecret } = data;
    await saveOAuthSettings("google", { clientId, clientSecret });

    after(() =>
      appendAuditLog({
        actorType: "user",
        actorId: sessionOrError.user.id!,
        eventType: "config.changed",
        detail: { key: SETTINGS_KEY_MAP["google"], provider: "google" },
        outcome: "success",
      })
    );
  }

  return NextResponse.json({ success: true });
}
