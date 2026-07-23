import { scrubEmails } from "@/lib/audit";

// Defense-in-depth for the tool-use audit's transport-error path.
//
// On the normal path, the pinchy-email plugin curates its own `details` and the
// route drops the raw params entirely (route.ts curatesNonErrorFields). But when
// OpenClaw's tool-use hook reports a dispatch-level failure it forwards no plugin
// result, so that curation never runs and the raw params — the recipient address
// and the full message body — would land verbatim in the append-only, HMAC-signed
// audit (AGENTS.md § Secret Handling: "Never write plaintext email addresses or
// other PII into audit detail"). Because the row is HMAC-signed, GDPR Art. 17
// erasure cannot remove it afterwards, so it must never be written.
//
// This backstop is deliberately scoped by tool name to the three email tools that
// carry PII in their params. It keeps the forensic value of the params (which
// fields were set, structured non-PII filters like folder/limit) while redacting
// the PII values: addresses and free-text terms are scrubbed, and the large body
// blob is reduced to a byte count (mirroring the plugin's `bodyBytes`).

const PII_PARAM_TOOLS = new Set(["email_send", "email_draft", "email_search"]);

// Params whose value is a message body — reduced to a byte count, never kept.
const BODY_PARAM_KEYS = new Set(["body"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Redact PII from the params of the email tools before they are logged raw.
 * No-op (returns the input unchanged) for any other tool or non-object params.
 * Never mutates the input — returns a shallow copy when it redacts.
 */
export function redactEmailToolParamsForAudit(toolName: string, params: unknown): unknown {
  if (!PII_PARAM_TOOLS.has(toolName)) return params;
  if (!isPlainObject(params)) return params;

  const out: Record<string, unknown> = { ...params };
  for (const [key, value] of Object.entries(out)) {
    if (typeof value !== "string") continue;
    if (BODY_PARAM_KEYS.has(key)) {
      out[key] = `<redacted ${Buffer.byteLength(value, "utf8")} bytes>`;
    } else {
      // Addresses (to/from/cc/bcc/replyTo) and free-text terms (subject/text)
      // may both carry an address — scrubEmails handles both.
      out[key] = scrubEmails(value);
    }
  }
  return out;
}
