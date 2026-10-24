import { NextRequest, NextResponse, after } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import {
  validateProviderKey,
  validateProviderUrl,
  PROVIDERS,
  type ProviderName,
} from "@/lib/providers";
import { getSetting, setSetting } from "@/lib/settings";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import {
  resetCache,
  fetchOllamaLocalModelsFromUrl,
  setOllamaLocalModels,
} from "@/lib/provider-models";
import { resolveAvailableModelForTemplate } from "@/lib/model-resolver/resolve-available";
import { TemplateCapabilityUnavailableError } from "@/lib/model-resolver/types";
import { SMITHERS_MODEL_HINT } from "@/lib/personal-agent";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { appendAuditLog } from "@/lib/audit";
import { parseRequestBody } from "@/lib/api-validation";
import { setupProviderSchema } from "@/lib/schemas/providers";
import { docsUrl } from "@/components/docs-link";

export async function POST(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const parsed = await parseRequestBody(setupProviderSchema, request);
  if ("error" in parsed) return parsed.error;
  const body = parsed.data;
  const { provider } = body;

  const config = PROVIDERS[provider];

  // #894 "first provider" gate. Read BEFORE saving so it reflects the state
  // prior to this provider. `default_provider` is null only on a pristine
  // instance — both this route and the custom OpenAI-compatible route set it on
  // the first provider — so `=== null` reliably means "nothing configured yet".
  //
  // This used to be decided two different, buggy ways: the default was set on
  // EVERY save (stealing an admin's chosen default), and the Smithers seed
  // repoint was gated on a built-in-ONLY key scan. When the instance's first
  // provider was a CUSTOM one, adding any built-in afterwards saw no configured
  // built-in, wrongly counted as "first", stole the default, and repointed the
  // existing Smithers agent — contradicting the documented contract that only
  // NEW agents follow a default change. Mirroring the custom route's
  // `currentDefault === null` gate fixes both and keeps the two routes
  // consistent: only the very first provider auto-defaults + seeds Smithers;
  // afterwards the default is an explicit "Set as default" action.
  const isFirstProvider = (await getSetting("default_provider")) === null;

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
      // #296 — Host won't pass OpenClaw's isLocalBaseUrl allowlist. Saving it
      // would let the URL sail through and fail silently at chat time with
      // "No API key found for provider 'ollama'". Surface a short message
      // naming the offending host, plus a structured `docs` link pointing at
      // option B of the Ollama setup guide. The client renders `docs.label`
      // as a real <a> next to the error so users can click instead of having
      // to copy-paste a URL out of inline text.
      if (validation.error === "unsupported_local_host") {
        return NextResponse.json(
          {
            error:
              `Host "${validation.host}" is not an allowed local Ollama host. ` +
              `Use localhost, a *.local alias, or a private IP.`,
            docs: {
              href: docsUrl("guides/ollama-setup", "b-ollama-as-a-docker-service"),
              label: "See the recommended Docker setup",
            },
          },
          { status: 422 }
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

    // Prime the ollama-local model cache that resolveModelForTemplate reads
    // below. The wizard fetches the model list directly (above) rather than
    // through fetchProviderModels(), which is the only other path that
    // populates this cache — without this, resolveModelForTemplate sees zero
    // installed models and Smithers falls back to anthropic (see
    // setOllamaLocalModels docstring).
    setOllamaLocalModels(ollamaModels);

    // Store URL unencrypted (not a secret)
    await setSetting(config.settingsKey, url, false);
    if (isFirstProvider) {
      await setSetting("default_provider", provider, false);
    }
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
    if (isFirstProvider) {
      await setSetting("default_provider", provider, false);
    }
  }

  // Only update agent model when adding the first provider. Looked up once:
  // the readiness id further down means this same agent, and an unfiltered
  // `findFirst()` only names Smithers on the first-provider path — see there.
  const smithers = isFirstProvider ? await db.query.agents.findFirst() : undefined;
  if (smithers) {
    try {
      const resolved = await resolveAvailableModelForTemplate({
        hint: SMITHERS_MODEL_HINT,
        provider: provider as ProviderName,
      });
      await db.update(agents).set({ model: resolved.model }).where(eq(agents.id, smithers.id));
    } catch (err) {
      if (!(err instanceof TemplateCapabilityUnavailableError)) {
        throw err;
      }
      // Provider has no model matching Smithers' hint — keep existing model.
    }
  }

  // Regenerate full OpenClaw config (includes agent list, provider env, model
  // defaults). This is best-effort: the provider key/URL is already committed
  // above, so a failed runtime apply must NOT surface as a 500 that implies
  // nothing saved (#880). apsa v0.8.0 saw this fire on every call (EACCES on
  // openclaw.json) — the setting persisted, the wizard showed an error, and a
  // refresh revealed it had actually saved. On failure we still return
  // success with a non-blocking warning; OpenClaw reconciles on its next
  // startup / config push.
  let runtimeWarning: string | undefined;
  try {
    await regenerateOpenClawConfig();
  } catch (err) {
    console.error("Failed to apply provider config to the OpenClaw runtime:", err);
    runtimeWarning =
      "Saved. Applying it to the agent runtime failed — check the server logs; it will retry on the next restart or config change.";
  }
  resetCache();

  // Runtime readiness is the WIZARD's wait, not this request's (#1150).
  //
  // The race is real and unchanged: `regenerateOpenClawConfig()` pushes to
  // OpenClaw in the background, so Smithers reaches OC's `agents.list` some
  // time AFTER this handler answers. Reach /chat/:smithersId before that and
  // the first dispatch fails with "invalid agent params: unknown agent id" —
  // the message never gets to the LLM and the chat looks hung (#445).
  //
  // What changed is who absorbs the gap. This route used to poll `agents.list`
  // for up to 30 s before answering, which is the wrong shape for a route a
  // human is watching: on a fresh install the gap is not small. Writing the
  // first secrets.json restarts the gateway, the restarts spend OC's
  // ~3-per-45 s `config.apply` budget, and Pinchy's push is then parked for the
  // advertised retry-after — 49 s in the run this was measured on. Nothing
  // crashed and no timeout fired; the request simply stayed open while the
  // wizard sat on a disabled "Validating..." button, a spinner indistinguishable
  // from a hang.
  //
  // So the wait moved to where it can be rendered. The id below lets the wizard
  // poll `GET /api/health/openclaw?agentId=…` — which already answers exactly
  // this question via `agentDispatchable` — show it as a named step, and time
  // out of it into an honest note instead of holding a connection open.
  //
  // Omitted in two cases. When the regenerate threw: nothing was pushed, so
  // OC's runtime is not about to change and polling it would only delay the
  // user past a gap that `warning` already describes. And when this is not the
  // instance's first provider: despite the path, this route also serves
  // Settings → AI Provider, where the instance has many agents and the
  // unfiltered `findFirst()` above answers whichever row comes back first. An
  // id chosen that way names nobody in particular, and this one is documented
  // as the agent a caller should poll — so it is only sent where it is true.
  // A Settings save that wants to know when its change landed has
  // `configPushesPending` on the same health endpoint, which is the question
  // it is actually asking.
  const agentId = runtimeWarning ? undefined : smithers?.id;

  // Build a CLAUDE.md-compliant audit detail: snapshot the human-readable
  // provider name alongside its id, and never log secrets. For URL-based
  // providers, log only the host:port (not the full URL) so internal
  // hostnames don't leak verbatim into the audit trail.
  const detail: Record<string, unknown> = {
    provider: { id: provider, name: PROVIDERS[provider].name },
    authType: config.authType,
    // What this asserts, precisely: `regenerateOpenClawConfig()` returned
    // without throwing. It is NOT a confirmation that OpenClaw's runtime now
    // holds the value — the push is fire-and-forget by design (see
    // pushConfigInBackground). It was called `runtimeApplied` until #943, where
    // a rotated key was audited as applied while every agent kept 401-ing; an
    // audit row claiming success for a change that did not take effect is worse
    // than no row at all.
    configRegenerated: !runtimeWarning,
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

  return NextResponse.json({ success: true, warning: runtimeWarning, agentId });
}
