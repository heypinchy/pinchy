/**
 * Build a compact, human-readable summary of tool-call arguments for the
 * confirmation card. This is OPERATIONAL data (stored on the tool_approval
 * row, shown to the approving user so they can decide in context) — it is
 * deliberately NOT written into the audit log, where only the PII-free
 * argsDigest is recorded.
 *
 * Secret-looking keys are redacted and long values truncated, so a leaked
 * summary never exposes a token; the recipient/subject of an email IS kept,
 * because hiding it would defeat the point of an informed confirmation.
 */
const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|cookie|credential)/i;
const MAX_VALUE_LEN = 200;
const MAX_KEYS = 25;

function summarizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_VALUE_LEN ? `${value.slice(0, MAX_VALUE_LEN)}…` : value;
  }
  if (value === null || ["number", "boolean"].includes(typeof value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return `[${value.length} item${value.length === 1 ? "" : "s"}]`;
  }
  if (typeof value === "object") {
    return `{${Object.keys(value as object).length} field${
      Object.keys(value as object).length === 1 ? "" : "s"
    }}`;
  }
  return String(value);
}

export function summarizeArgs(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return {};
  }
  const entries = Object.entries(params as Record<string, unknown>).slice(0, MAX_KEYS);
  const out: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    out[key] = SECRET_KEY.test(key) ? "[redacted]" : summarizeValue(value);
  }
  return out;
}
