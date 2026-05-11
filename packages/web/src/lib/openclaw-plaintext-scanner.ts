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
  // MCP token prefixes for Phase-1 presets — these must never appear in
  // openclaw.json (credentials are fetched at runtime via /api/internal/integrations).
  // GitHub fine-grained PAT must be checked before classic PAT and OAuth token
  // because "github_pat_" starts with "ghp" which could false-match if order reversed.
  { name: "github-pat-fine-grained", regex: /^github_pat_[a-zA-Z0-9_]{10,}/ },
  { name: "github-pat-classic", regex: /^ghp_[a-zA-Z0-9]{10,}/ },
  { name: "github-oauth", regex: /^gho_[a-zA-Z0-9]{10,}/ },
  // Notion internal integration tokens start with "secret_" followed by ≥32 chars.
  { name: "notion-integration", regex: /^secret_[a-zA-Z0-9]{32,}/ },
  // Linear personal API keys start with "lin_api_".
  { name: "linear-api-key", regex: /^lin_api_[a-zA-Z0-9]{8,}/ },
  // GitLab personal access tokens start with "glpat-"; project tokens with "glptt-".
  { name: "gitlab-pat", regex: /^glpat-[a-zA-Z0-9_-]{16,}/ },
  { name: "gitlab-project-token", regex: /^glptt-[a-zA-Z0-9_-]{16,}/ },
  // Stripe restricted keys (rk_live_/rk_test_) and secret keys (sk_live_/sk_test_).
  // "sk-" anthropic-style is already covered above; here we match "sk_" Stripe-style.
  { name: "stripe-restricted-key", regex: /^rk_(live|test)_[a-zA-Z0-9]{16,}/ },
  { name: "stripe-secret-key", regex: /^sk_(live|test)_[a-zA-Z0-9]{16,}/ },
  // HighLevel Private Integration Tokens start with "pit-".
  { name: "highlevel-pit", regex: /^pit-[a-f0-9]{8,}/ },
  // Atlassian, Cloudflare, Intercom tokens are opaque strings with no fixed
  // prefix — there's nothing to match defensively. The Pattern-B fetch contract
  // is the primary guarantee; the manifest's `additionalProperties: false` is
  // the secondary one. Reach for the audit trail if either of those slips.
  //
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
