// Defense-in-depth check. Add a pattern for every new provider whose secret
// shape can be recognized by prefix — otherwise the scanner can silently miss
// a leak when a future migration forgets to route through SecretRef. See
// `packages/web/src/lib/providers.ts` for the canonical provider list; any new
// entry there with a recognizable key prefix should also land here.
const PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "anthropic", regex: /^sk-ant-[a-zA-Z0-9_-]{16,}/ },
  { name: "openai-generic", regex: /^sk-(proj-)?[a-zA-Z0-9]{16,}/ },
  { name: "gemini", regex: /^AIza[a-zA-Z0-9_-]{30,}/ },
  { name: "brave", regex: /^BSA[a-zA-Z0-9]{16,}/ },
  // Ollama Cloud: 32-hex prefix + "." + ≥16 base62 chars (observed format).
  { name: "ollama-cloud", regex: /^[a-f0-9]{32}\.[a-zA-Z0-9]{16,}/ },
  // telegram-bot tokens omitted: OpenClaw 2026.4.26 does not resolve SecretRef
  // in channels.telegram.accounts.*.botToken — tokens stay as plain strings.
];

export type Finding = { path: string; pattern: string };

export function findPlaintextSecrets(config: unknown, prefix = ""): Finding[] {
  const findings: Finding[] = [];
  walk(config, prefix, findings);
  return findings;
}

function walk(value: unknown, path: string, findings: Finding[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    for (const { name, regex } of PATTERNS) {
      if (regex.test(value)) {
        findings.push({ path, pattern: name });
        return;
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${path}[${i}]`, findings));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walk(v, path ? `${path}.${k}` : k, findings);
    }
  }
}

export function assertNoPlaintextSecrets(config: unknown): void {
  const hits = findPlaintextSecrets(config);
  if (hits.length > 0) {
    const msg = hits.map((h) => `  ${h.path} matches ${h.pattern}`).join("\n");
    throw new Error(`plaintext secret detected in config:\n${msg}`);
  }
}
