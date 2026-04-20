const MAPPED_MODELS = new Set(["gpt-4o", "gpt-4o-mini", "o1", "o1-mini", "o3-mini", "o4-mini"]);

export function toCodexModel(m: string): string | null {
  if (!m.startsWith("openai/")) return null;
  const name = m.slice("openai/".length);
  return MAPPED_MODELS.has(name) ? `openai-codex/${name}` : null;
}

export function toOpenAiModel(m: string): string | null {
  if (!m.startsWith("openai-codex/")) return null;
  const name = m.slice("openai-codex/".length);
  return MAPPED_MODELS.has(name) ? `openai/${name}` : null;
}
