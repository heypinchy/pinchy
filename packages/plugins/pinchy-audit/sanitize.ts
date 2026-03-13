/**
 * Sanitize sensitive data from audit log payloads.
 *
 * Redacts known secret patterns (API keys, tokens, passwords)
 * from tool parameters and results before logging.
 */

const REDACTED = "[REDACTED]";

/** Patterns that match known secret values */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  // API keys: sk-*, sk_*, key-*, key_*, api-*, api_*
  /^(sk[-_]|key[-_]|api[-_])[a-zA-Z0-9]{8,}/,
  // Bearer tokens
  /^Bearer\s+[a-zA-Z0-9._\-]{20,}/i,
  // AWS keys
  /^AKIA[0-9A-Z]{16}$/,
  // GitHub tokens
  /^(ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}/,
  // npm tokens
  /^npm_[a-zA-Z0-9]{36,}/,
  // Generic long hex/base64 strings (likely tokens)
  /^[a-f0-9]{40,}$/i,
  /^[A-Za-z0-9+/]{40,}={0,2}$/,
  // JWTs
  /^eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/,
];

/** Keys whose values should always be redacted */
const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /^(api[_-]?key|apikey)$/i,
  /^(secret[_-]?key|secretkey)$/i,
  /^(access[_-]?token|accesstoken)$/i,
  /^(auth[_-]?token|authtoken)$/i,
  /^(private[_-]?key|privatekey)$/i,
  /^(password|passwd|pwd)$/i,
  /^(token)$/i,
  /^(authorization)$/i,
  /^(credentials?)$/i,
  /^(connection[_-]?string)$/i,
  /^(database[_-]?url)$/i,
  /^.*[_-](key|secret|token|password|pwd)$/i,
];

/** Check if a key name looks like it contains sensitive data */
function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((p) => p.test(key));
}

/** Check if a value looks like a secret */
function isSensitiveValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((p) => p.test(value));
}

/** Recursively sanitize an object, redacting sensitive values */
export function sanitize(obj: unknown, depth = 0): unknown {
  // Prevent infinite recursion
  if (depth > 10) return REDACTED;

  if (obj === null || obj === undefined) return obj;

  if (typeof obj === "string") {
    return isSensitiveValue(obj) ? REDACTED : obj;
  }

  if (typeof obj === "number" || typeof obj === "boolean") return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitize(item, depth + 1));
  }

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        result[key] = REDACTED;
      } else if (typeof value === "string" && isSensitiveValue(value)) {
        result[key] = REDACTED;
      } else {
        result[key] = sanitize(value, depth + 1);
      }
    }
    return result;
  }

  return obj;
}
