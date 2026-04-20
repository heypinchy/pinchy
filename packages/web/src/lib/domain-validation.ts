// Each label: 1-63 chars, alphanumeric + hyphens (not leading/trailing hyphen).
// At least two labels required (no bare "localhost" etc.).
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function isValidDomain(domain: string): boolean {
  return DOMAIN_RE.test(domain.toLowerCase());
}
