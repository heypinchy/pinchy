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
/**
 * Generate a human-readable connection name from an Odoo URL.
 *
 * Examples:
 *   "https://mycompany.odoo.com"         → "Mycompany Odoo"
 *   "https://odoo.gittermattenzaun.at"   → "Gittermattenzaun Odoo"
 *   "https://erp.mueller.com"            → "Mueller Odoo"
 *   "http://localhost:8069"              → "Localhost Odoo"
 */
export function generateConnectionName(url: string): string {
  try {
    const hostname = new URL(url).hostname;

    // Odoo SaaS: use subdomain
    const odooMatch = hostname.match(/^([^.]+)\.(?:dev\.)?odoo\.com$/);
    if (odooMatch) {
      const parts = odooMatch[1].split("-");
      const titleCased = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
      return `${titleCased} Odoo`;
    }

    // IP address: use as-is
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
      return `${hostname} Odoo`;
    }

    // Self-hosted: pick the most meaningful part of the hostname
    // "odoo.gittermattenzaun.at" → "Gittermattenzaun"
    // "erp.mueller.com" → "Mueller"
    // "localhost" → "Localhost"
    const parts = hostname.split(".");
    // Skip common prefixes (odoo, erp, www) and TLDs
    const skipPrefixes = new Set(["odoo", "erp", "www", "app", "portal"]);
    const skipSuffixes = new Set(["com", "net", "org", "at", "de", "ch", "io", "co"]);
    const meaningful = parts.filter((p) => !skipPrefixes.has(p) && !skipSuffixes.has(p));
    const label = meaningful.length > 0 ? meaningful[0] : parts[0];
    const capitalized = label.charAt(0).toUpperCase() + label.slice(1);
    return `${capitalized} Odoo`;
  } catch {
    return "Odoo";
  }
}

export function parseOdooSubdomainHint(url: string): string | null {
  try {
    const hostname = new URL(url).hostname;
    const match = hostname.match(/^([^.]+)\.(?:dev\.)?odoo\.com$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
