/**
 * Convert a provider-prefixed model ID to a human-readable display name.
 *
 * Examples:
 *   "anthropic/claude-sonnet-4-6"  → "Claude Sonnet 4.6"
 *   "openai/gpt-5.5"               → "Gpt 5.5"
 *   "google/gemini-2.5-pro"        → "Gemini 2.5 Pro"
 *   "ollama/llama3.2"              → "Llama3.2"
 */
export function getModelDisplayName(modelId: string): string {
  const withoutPrefix = modelId.split("/").slice(1).join("/");
  return withoutPrefix.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
