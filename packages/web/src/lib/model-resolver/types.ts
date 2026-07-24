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
  /**
   * A fixed built-in `ProviderName` OR a custom OpenAI-compatible instance's
   * dynamic slug (#894). `default_provider` and an agent's `model` can now
   * legitimately hold a slug, so the resolver accepts the widened id and routes
   * unknown-to-the-union values through the custom-provider path.
   */
  provider: ProviderName | (string & {});
}

export interface ResolverResult {
  model: string;
  reason: string;
  fallbackUsed: boolean;
}

export class TemplateCapabilityUnavailableError extends Error {
  constructor(
    public missingCapabilities: ModelCapability[],
    // Widened to match ResolverInput.provider (#894): callers now throw this for
    // custom OpenAI-compatible slugs too (e.g. resolve-available.ts passes
    // `input.provider`), not just the fixed built-in ProviderName union. The
    // field is only used for the human-readable message, so accepting a slug is
    // safe; a bare `ProviderName` here breaks the merge with main's resolver.
    public provider: ProviderName | (string & {}),
    public docsUrl: string
  ) {
    super(
      `Template requires ${missingCapabilities.join(", ")} but provider ${provider} has no matching model.`
    );
    this.name = "TemplateCapabilityUnavailableError";
  }
}
