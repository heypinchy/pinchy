import type { ProviderName } from "@/lib/providers";

export type ModelTier = "fast" | "balanced" | "reasoning";
export type ModelTaskType = "general" | "coder" | "vision" | "reasoning";
export type ModelCapability = "vision" | "long-context" | "tools";

export interface ModelHint {
  tier: ModelTier;
  taskType?: ModelTaskType;
  capabilities?: ModelCapability[];
}

export interface ResolverInput {
  hint: ModelHint;
  provider: ProviderName;
}

export interface ResolverResult {
  model: string;
  reason: string;
  fallbackUsed: boolean;
}

export class TemplateCapabilityUnavailableError extends Error {
  constructor(
    public missingCapabilities: ModelCapability[],
    public provider: ProviderName,
    public docsUrl: string
  ) {
    super(
      `Template requires ${missingCapabilities.join(", ")} but provider ${provider} has no matching model.`
    );
    this.name = "TemplateCapabilityUnavailableError";
  }
}
