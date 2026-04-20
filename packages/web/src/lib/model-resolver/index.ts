import { getOllamaLocalModels } from "@/lib/provider-models";
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
  }
}
