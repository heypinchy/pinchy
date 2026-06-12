import type { ProviderName } from "@/lib/providers";

export type ModelTier = "fast" | "balanced" | "reasoning";
export type ModelTaskType = "general" | "coder" | "vision" | "reasoning";
// documents/audio/video were removed: PDFs route via the pdf tool and
// audio/video files are not uploadable (ALLOWED_ATTACHMENT_MIMES, #321).
type InputModality = "vision";
type ModelTrait = "long-context" | "tools";
export type ModelCapability = InputModality | ModelTrait;

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
