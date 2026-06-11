const REDACTED = "[REDACTED]";
const MAX_DEPTH = 10;

// SYNC: This sanitization logic is duplicated in packages/plugins/pinchy-audit/index.ts
// Keep both copies in sync when adding/removing patterns.
const SENSITIVE_KEY_PATTERNS = [
  "password",
  "secret",
  "token",
  "apikey",
  "api_key",
  "authorization",
  "credential",
  "private_key",
  "privatekey",
  "passphrase",
  "access_key",
  "accesskey",
  "client_secret",
  "clientsecret",
];

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Numeric values under keys ending in "tokens" are token COUNTS (usage
 * counters like `gen_ai.usage.input_tokens`, `cacheReadTokens`), not
 * credentials — the blanket "token" key match redacted them all, destroying
 * the usage data in every diagnostics bundle. Conservative on purpose: only
 * numbers are exempt; a string under `refreshTokens` stays redacted.
 */
function isExemptTokenCount(key: string, value: unknown): boolean {
  return typeof value === "number" && /tokens$/i.test(key);
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[a-zA-Z0-9\-]{20,}/g, // Anthropic (must be before generic sk-)
  /sk-[a-zA-Z0-9]{20,}/g, // OpenAI
  /ghp_[a-zA-Z0-9]{36,}/g, // GitHub PAT
  /gho_[a-zA-Z0-9]{36,}/g, // GitHub OAuth
  /github_pat_[a-zA-Z0-9_]{20,}/g, // GitHub fine-grained PAT
  /xoxb-[a-zA-Z0-9\-]+/g, // Slack bot token
  /xoxp-[a-zA-Z0-9\-]+/g, // Slack user token
  /Bearer\s+[a-zA-Z0-9._\-]{20,}/g, // Bearer auth
  /[0-9]{8,10}:[a-zA-Z0-9_\-]{35}/g, // Telegram bot token
  /EAA[a-zA-Z0-9]{20,}/g, // Meta/Facebook access token
];

const ENV_SECRET_LINE = /^([A-Z_]*(SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL)[A-Z_]*)=(.+)$/gim;

function redactPatterns(value: string): string {
  if (value === REDACTED) return value;

  let result = value;

  // First: env-file lines (preserves key, redacts value)
  ENV_SECRET_LINE.lastIndex = 0;
  result = result.replace(ENV_SECRET_LINE, `$1=${REDACTED}`);

  // Then: inline secret patterns
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, REDACTED);
  }

  return result;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (depth >= MAX_DEPTH) return value;

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }

  // Dates have no own enumerable properties — the generic object branch below
  // would strip them to {} (which shipped empty timestamps in diagnostics
  // bundles). Serialize them like JSON.stringify would.
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (
        isSensitiveKey(key) &&
        val !== null &&
        val !== undefined &&
        !isExemptTokenCount(key, val)
      ) {
        result[key] = REDACTED;
      } else {
        result[key] = sanitizeValue(val, depth + 1);
      }
    }
    return result;
  }

  if (typeof value === "string") {
    return redactPatterns(value);
  }

  return value;
}

export function sanitizeDetail<T>(detail: T): T {
  if (detail === null || detail === undefined) return detail;
  return sanitizeValue(detail, 0) as T;
}
