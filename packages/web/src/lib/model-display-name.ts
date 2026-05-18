/**
 * Convert a provider-prefixed model ID to a human-readable display name.
 *
 * Examples:
 *   "anthropic/claude-sonnet-4-6"  → "Claude Sonnet 4.6"
 *   "openai/gpt-5.5"               → "GPT 5.5"
 *   "google/gemini-2.5-pro"        → "Gemini 2.5 Pro"
 *   "ollama-cloud/qwen3-next:80b"  → "Qwen3 Next"
 *   "ollama/llama3.2"              → "Llama3.2"
 */
export function getModelDisplayName(modelId: string): string {
  // Strip provider prefix (e.g. "anthropic/")
  const withoutPrefix = modelId.split("/").slice(1).join("/");

  // Remove parameter suffix (e.g. ":80b" for ollama models)
  const withoutSuffix = withoutPrefix.split(":")[0];

  // Replace hyphens between digits with dots (version notation: 4-6 → 4.6)
  const withVersionDots = withoutSuffix.replace(/(\d)-(\d)/g, "$1.$2");

  // Replace remaining hyphens with spaces
  const withSpaces = withVersionDots.replace(/-/g, " ");

  // Capitalize first letter of each word, handle known acronyms
  return withSpaces.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bGpt\b/g, "GPT");
}
