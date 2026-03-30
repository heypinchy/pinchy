/**
 * Normalize an Odoo URL to just the origin (protocol + host).
 * Strips paths, trailing slashes, query strings, and fragments.
 *
 * Examples:
 *   "https://odoo.example.com/"              → "https://odoo.example.com"
 *   "https://odoo.example.com/odoo"          → "https://odoo.example.com"
 *   "https://odoo.example.com/web/login?x=1" → "https://odoo.example.com"
 *
 * Returns null for invalid URLs.
 */
export function normalizeOdooUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Try to extract the database name from an Odoo SaaS URL subdomain.
 *
 * Examples:
 *   "https://mycompany.odoo.com"                               → "mycompany"
 *   "https://traun-capital-staging-pinchy-30159487.dev.odoo.com" → "traun-capital-staging-pinchy-30159487"
 *   "https://odoo.myserver.com"                                 → null
 */
export function parseOdooSubdomainHint(url: string): string | null {
  try {
    const hostname = new URL(url).hostname;
    const match = hostname.match(/^([^.]+)\.(?:dev\.)?odoo\.com$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
