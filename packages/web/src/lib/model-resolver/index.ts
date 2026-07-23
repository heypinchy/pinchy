import { getOllamaLocalModels } from "@/lib/provider-models";
import { listOpenAiCompatibleProviders } from "@/lib/openai-compatible-providers";
import type { ResolverInput, ResolverResult } from "./types";
import { resolveAnthropic } from "./providers/anthropic";
import { resolveOpenAI } from "./providers/openai";
import { resolveGoogle } from "./providers/google";
import { resolveOllamaCloud } from "./providers/ollama-cloud";
import { resolveOllamaLocal } from "./providers/ollama-local";

export * from "./types";

export async function resolveModelForTemplate(input: ResolverInput): Promise<ResolverResult> {
  const { hint, provider } = input;
  switch (provider) {
    case "anthropic":
      return resolveAnthropic(hint);
    case "openai":
      return resolveOpenAI(hint);
    case "google":
      return resolveGoogle(hint);
    case "ollama-cloud":
      return resolveOllamaCloud(hint);
    case "ollama-local":
      return resolveOllamaLocal(hint, getOllamaLocalModels());
    default:
      // Custom OpenAI-compatible instance (#894). The provider is a slug, not a
      // built-in ProviderName. Custom instances carry no tier metadata, so the
      // hint's tier/capabilities don't select among models — the instance's
      // first persisted model is its default, namespaced `<slug>/<modelId>` to
      // match the openclaw.json emission and the delete-migration choice.
      return resolveCustomProvider(provider);
  }
}

async function resolveCustomProvider(slug: string): Promise<ResolverResult> {
  const match = (await listOpenAiCompatibleProviders()).find((p) => p.slug === slug);
  if (!match) {
    // A slug that is neither a built-in nor a live instance. Fail loudly with a
    // defined error rather than returning `undefined` (which callers deref into
    // a TypeError). This preserves today's "unknown provider" failure mode.
    throw new Error(`Unknown provider: ${slug}`);
  }
  if (match.models.length === 0) {
    // Unreachable today (the create schema guarantees models.min(1)), but keep
    // this symmetric with getDefaultModel's zero-model guard so neither path can
    // raw-TypeError on `models[0]`.
    throw new Error(`Provider ${slug} has no models`);
  }
  const modelId = match.models[0].id;
  const model = `${slug}/${modelId}`;
  return {
    model,
    reason: `custom: provider=${slug} → ${modelId}`,
    fallbackUsed: false,
  };
}
