import { NextResponse, after } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { setDefaultProviderSchema } from "@/lib/schemas/provider-default";
import { PROVIDERS, type ProviderName } from "@/lib/providers";
import { getSetting, setSetting } from "@/lib/settings";
import { listOpenAiCompatibleProviders } from "@/lib/openai-compatible-providers";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { resetCache } from "@/lib/provider-models";
import { appendAuditLog } from "@/lib/audit";

// Explicit "Set as default" for the unified AI-Provider settings grid (#894).
// Built-in providers only ever became `default_provider` implicitly, as a
// side effect of re-saving a key via /api/setup/provider — and a custom
// OpenAI-compatible instance couldn't become the default at all once it
// wasn't the very first provider configured. This route lets an admin flip
// `default_provider` directly, to either a built-in name or a custom slug.
//
// Setting the default only changes which provider NEW agents resolve onto —
// existing agents keep their pinned `<provider>/<model>` untouched, so there
// is no agent migration here (unlike the provider DELETE routes).

function isBuiltInProviderName(value: string): value is ProviderName {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, value);
}

export const PATCH = withAdmin(async (request, _ctx, session) => {
  const parsed = await parseRequestBody(setDefaultProviderSchema, request);
  if ("error" in parsed) return parsed.error;
  const { provider } = parsed.data;

  // Validate the target is actually configured — a built-in with a settings
  // key present, or an existing custom slug — before ever touching
  // `default_provider`. This is the same "don't let the UI point at nothing"
  // guard as the built-in/custom DELETE routes' last-provider check, just for
  // the opposite direction (nothing to fall back onto if the target is bogus).
  let targetName: string;
  if (isBuiltInProviderName(provider)) {
    const config = PROVIDERS[provider];
    const value = await getSetting(config.settingsKey);
    if (value === null) {
      return NextResponse.json(
        { error: "That provider isn't configured yet. Add a key or URL first." },
        { status: 400 }
      );
    }
    targetName = config.name;
  } else {
    const customProviders = await listOpenAiCompatibleProviders();
    const match = customProviders.find((p) => p.slug === provider);
    if (!match) {
      return NextResponse.json({ error: "Provider not found." }, { status: 404 });
    }
    targetName = match.displayName;
  }

  const previousDefault = await getSetting("default_provider");

  await setSetting("default_provider", provider, false);

  // Best-effort runtime apply (#880 pattern, mirrored across every provider
  // write route): the setting is already committed, so a failed regenerate
  // must not turn a successful save into a 500. The audited flag asserts only
  // that the regenerate did not throw — the push itself is fire-and-forget, so
  // it is deliberately NOT named `runtimeApplied` (see setup/provider, #943).
  let configRegenerated = true;
  let warning: string | undefined;
  try {
    await regenerateOpenClawConfig();
  } catch (err) {
    console.error("Failed to apply the new default provider to the runtime:", err);
    configRegenerated = false;
    warning =
      "Saved. Applying it to the agent runtime failed — check the server logs; it will retry on the next restart or config change.";
  }
  resetCache();

  after(() =>
    appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "config.changed",
      outcome: "success",
      detail: {
        provider: { id: provider, name: targetName },
        previousDefault,
        newDefault: provider,
        configRegenerated,
      },
    })
  );

  return NextResponse.json({
    success: true,
    defaultProvider: provider,
    ...(warning ? { warning } : {}),
  });
});
