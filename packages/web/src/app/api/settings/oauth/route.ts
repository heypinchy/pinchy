import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/api-auth";
import { getOAuthSettings, saveOAuthSettings } from "@/lib/integrations/oauth-settings";
import { getOAuthProvider } from "@/lib/integrations/oauth-providers";
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

export async function GET(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const provider = request.nextUrl.searchParams.get("provider");
  if (!provider || !isSupportedProvider(provider)) {
    return NextResponse.json({ error: "Invalid or missing provider" }, { status: 400 });
  }

  // Tenant-scoped providers (Microsoft) also surface the stored tenantId so
  // the edit dialog can prefill it. The client secret is never returned.
  if (provider === "microsoft") {
    const settings = await getOAuthSettings("microsoft");
    if (!settings) {
      return NextResponse.json({ configured: false, clientId: "" });
    }
    return NextResponse.json({
      configured: true,
      clientId: settings.clientId,
      tenantId: settings.tenantId ?? "",
    });
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

  // Persist per-provider settings (Microsoft carries an optional tenantId). The
  // save stays branch-narrowed so saveOAuthSettings' generic gets the exact
  // ProviderSettings[P] shape it expects; the audit write below is shared.
  if (data.provider === "microsoft") {
    const { clientId, clientSecret, tenantId } = data;
    await saveOAuthSettings(
      "microsoft",
      tenantId ? { clientId, clientSecret, tenantId } : { clientId, clientSecret }
    );
  } else {
    const { clientId, clientSecret } = data;
    await saveOAuthSettings("google", { clientId, clientSecret });
  }

  const provider = data.provider;
  // getOAuthProvider is non-null for the discriminated-union providers; its
  // settingsKey is the same value as the audit rows recorded before this
  // refactor (google_oauth_credentials / microsoft_oauth_credentials).
  const settingsKey = getOAuthProvider(provider)!.settingsKey;
  after(() =>
    appendAuditLog({
      actorType: "user",
      actorId: sessionOrError.user.id!,
      resource: `integration:${provider}-oauth`,
      eventType: "config.changed",
      detail: { key: settingsKey, provider },
      outcome: "success",
    })
  );

  return NextResponse.json({ success: true });
}
