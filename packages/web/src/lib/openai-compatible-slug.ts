export const RESERVED_PROVIDER_SLUGS = new Set([
  "anthropic",
  "openai",
  "google",
  "ollama-cloud",
  "ollama-local",
  "ollama",
]);

export function deriveProviderSlug(displayName: string, existing: Set<string>): string {
  const base =
    displayName
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "provider";
  const taken = (s: string) => existing.has(s) || RESERVED_PROVIDER_SLUGS.has(s);
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken(candidate)) return candidate;
  }
}
