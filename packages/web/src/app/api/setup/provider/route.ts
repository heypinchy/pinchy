import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/api-auth";
import {
  validateProviderKey,
  validateProviderUrl,
  PROVIDERS,
  type ProviderName,
} from "@/lib/providers";
import { getSetting, setSetting } from "@/lib/settings";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { resetCache, getDefaultModel, fetchOllamaLocalModelsFromUrl } from "@/lib/provider-models";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { appendAuditLog } from "@/lib/audit";
import { parseRequestBody } from "@/lib/api-validation";

const VALID_PROVIDERS = Object.keys(PROVIDERS) as ProviderName[];

const setupProviderSchema = z.object({
  provider: z.enum(VALID_PROVIDERS as [ProviderName, ...ProviderName[]]),
  url: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
});

export async function POST(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const parsed = await parseRequestBody(setupProviderSchema, request);
  if ("error" in parsed) return parsed.error;
  const body = parsed.data;
  const { provider } = body;

  const config = PROVIDERS[provider];

  if (config.authType === "url") {
    // URL-based provider (ollama-local)
    const { url } = body;
    if (!url) {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }

    const validation = await validateProviderUrl(url);
    if (!validation.valid) {
      if (validation.error === "network_error") {
        return NextResponse.json(
          {
            error:
              "Could not connect to Ollama at this URL. Ensure Ollama is running and accessible.",
          },
          { status: 502 }
        );
      }
      return NextResponse.json(
        {
          error: `Ollama returned an error (HTTP ${(validation as { status: number }).status}).`,
        },
        { status: 502 }
      );
    }

    // Check that at least one model supports tool calling
    const ollamaModels = await fetchOllamaLocalModelsFromUrl(url);
    const hasToolCapable = ollamaModels.some((m) => m.capabilities.tools);

    if (!hasToolCapable) {
      const message =
        ollamaModels.length === 0
          ? "No models found. Pull a compatible model first: ollama pull qwen2.5:7b"
          : "No compatible models found. Pinchy agents require tool support. Pull a compatible model: ollama pull qwen2.5:7b";
      return NextResponse.json({ error: message }, { status: 422 });
    }

    // Store URL unencrypted (not a secret)
    await setSetting(config.settingsKey, url, false);
    await setSetting("default_provider", provider, false);
  } else {
    // API-key-based provider (existing logic)
    const { apiKey } = body;
    if (!apiKey) {
      return NextResponse.json({ error: "API key is required" }, { status: 400 });
    }

    const validation = await validateProviderKey(provider, apiKey);
    if (!validation.valid) {
      if (validation.error === "invalid_key") {
        return NextResponse.json(
          { error: "Invalid API key. Please check and try again." },
          { status: 422 }
        );
      }
      if (validation.error === "network_error") {
        return NextResponse.json(
          {
            error: "Could not reach the provider API. Please check your network and try again.",
          },
          { status: 502 }
        );
      }
      // provider_error (429, 5xx, etc.)
      if (validation.error === "provider_error") {
        return NextResponse.json(
          {
            error: `The provider returned an error (HTTP ${validation.status}). The key may be valid — please try again in a moment.`,
          },
          { status: 502 }
        );
      }
      return NextResponse.json({ error: "Validation failed" }, { status: 400 });
    }

    // Store encrypted key and default provider
    await setSetting(config.settingsKey, apiKey, true);
    await setSetting("default_provider", provider, false);
  }

  // Check if any other providers are already configured (before saving the new one)
  let isFirstProvider = true;
  for (const [name, providerConfig] of Object.entries(PROVIDERS)) {
    if (name !== provider) {
      const existingKey = await getSetting(providerConfig.settingsKey);
      if (existingKey !== null) {
        isFirstProvider = false;
        break;
      }
    }
  }

  // Only update agent model when adding the first provider
  if (isFirstProvider) {
    const smithers = await db.query.agents.findFirst();
    if (smithers) {
      const defaultModel = await getDefaultModel(provider as ProviderName);
      await db.update(agents).set({ model: defaultModel }).where(eq(agents.id, smithers.id));
    }
  }

  // Regenerate full OpenClaw config (includes agent list, provider env, model defaults)
  await regenerateOpenClawConfig();
  resetCache();

  // Build a CLAUDE.md-compliant audit detail: snapshot the human-readable
  // provider name alongside its id, and never log secrets. For URL-based
  // providers, log only the host:port (not the full URL) so internal
  // hostnames don't leak verbatim into the audit trail.
  const detail: Record<string, unknown> = {
    provider: { id: provider, name: PROVIDERS[provider].name },
    authType: config.authType,
  };
  if (config.authType === "url" && body.url) {
    try {
      const parsedUrl = new URL(body.url);
      detail.host = parsedUrl.host;
    } catch {
      // Invalid URL — this would have been rejected by validateProviderUrl
      // already, so this branch is only reached in tests.
    }
  }

  after(() =>
    appendAuditLog({
      actorType: "user",
      actorId: sessionOrError.user.id!,
      eventType: "config.changed",
      outcome: "success",
      detail,
    })
  );

  return NextResponse.json({ success: true });
}
