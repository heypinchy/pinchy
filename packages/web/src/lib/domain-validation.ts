// Each label: 1-63 chars, alphanumeric + hyphens (not leading/trailing hyphen).
// At least two labels required (no bare "localhost" etc.).
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function isValidDomain(domain: string): boolean {
  return DOMAIN_RE.test(domain.toLowerCase());
}

/**
 * Validate the `pinchy-web` entry inside an agent's pluginConfig. Returns an
 * error message string on failure, or null when the config is absent or valid.
 * Shared between POST /api/agents and PATCH /api/agents/[id] so both routes
 * apply the same allow-list to `allowedDomains` / `excludedDomains`.
 */
export function validatePinchyWebConfig(pluginConfig: unknown): string | null {
  if (pluginConfig === undefined || pluginConfig === null) return null;
  if (typeof pluginConfig !== "object" || Array.isArray(pluginConfig)) {
    return "pluginConfig must be an object";
  }
  const webCfg = (pluginConfig as Record<string, unknown>)["pinchy-web"];
  if (webCfg === undefined) return null;
  if (typeof webCfg !== "object" || webCfg === null || Array.isArray(webCfg)) {
    return "pluginConfig['pinchy-web'] must be an object";
  }
  const { allowedDomains, excludedDomains } = webCfg as Record<string, unknown>;
  for (const [key, value] of [
    ["allowedDomains", allowedDomains],
    ["excludedDomains", excludedDomains],
  ] as const) {
    if (value === undefined) continue;
    if (
      !Array.isArray(value) ||
      !(value as unknown[]).every((d) => typeof d === "string" && isValidDomain(d))
    ) {
      return `Invalid domain in ${key}`;
    }
  }
  return null;
}
