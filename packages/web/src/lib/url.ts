/**
 * Normalize a user-entered URL to its origin (protocol + host[:port]).
 *
 * - Prepends `https://` if no protocol is given (so users can paste a bare host).
 * - Strips path, query string, fragment, and trailing slashes.
 * - Trims surrounding whitespace.
 *
 * Examples:
 *   "odoo-demo.heypinchy.com"           → "https://odoo-demo.heypinchy.com"
 *   "https://odoo.example.com/web?x=1"  → "https://odoo.example.com"
 *   "http://localhost:8069/"            → "http://localhost:8069"
 *
 * Returns `null` for empty or syntactically unrepairable input — callers
 * should then fall back to their own validation (e.g. zod's `.url()`).
 */
export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    // Reject hostnames that look like garbage (e.g. user typed prose).
    // A bare hostname without a TLD or a port is technically valid per URL spec
    // but rarely what the user meant — except for `localhost`, which we allow.
    if (!parsed.hostname || /\s/.test(parsed.hostname)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}
