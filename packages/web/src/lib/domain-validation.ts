import { z } from "zod";

import { isPathUnderDataRoot } from "./knowledge/citation-path";

// Each label: 1-63 chars, alphanumeric + hyphens (not leading/trailing hyphen).
// At least two labels required (no bare "localhost" etc.).
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function isValidDomain(domain: string): boolean {
  return DOMAIN_RE.test(domain.toLowerCase());
}

/**
 * Zod schema for an agent's pluginConfig column. Mirrors the AgentPluginConfig
 * type in @/db/schema and is the shape-of-truth for both POST and PATCH agent
 * routes. Domain validity inside `pinchy-web` is layered on top via
 * `validatePinchyWebConfig` (it's a content check, not a shape check).
 *
 * `allowed_paths` is confined HERE rather than in a route, and that placement
 * is the fix rather than an implementation detail. It is not a preference: it
 * is the allowlist that scopes the agent's file tools, its knowledge-base
 * retrieval filter, and the browser-facing
 * `GET /api/agents/[id]/workspace-file` route. The two routes that write it
 * disagreed — POST confined it only when `template.pluginId ===
 * "pinchy-files"`, PATCH not at all — and since PATCH gates `allowedTools`,
 * `visibility` and `groupIds` on the admin role but never gated
 * `pluginConfig`, any member could point their own seeded personal agent at
 * `/` and read the container's secrets. A boundary each caller has to
 * remember is a boundary that a third caller will not have.
 */
export const pluginConfigSchema = z
  .object({
    "pinchy-files": z
      .object({
        allowed_paths: z.array(z.string()).refine((paths) => paths.every(isPathUnderDataRoot), {
          message: "allowed_paths entries must be directories under /data",
        }),
        // Not confined to /data, and it does not have to be: nothing reads a
        // STORED write_paths. `build.ts` derives the emitted list itself
        // (workspace uploads/workbench/memory, only when pinchy_write is
        // granted) and never looks at this field, so it is accepted for
        // backward compatibility with rows that already carry it rather than
        // as a grant anyone can widen. `write_paths ⊆ allowed_paths` is
        // enforced on that emitted list (validate-built-config.ts) and again
        // in the plugin at runtime (pinchy-files validate.ts).
        write_paths: z.array(z.string()).optional(),
        allowed_extensions: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    "pinchy-web": z
      .object({
        allowedDomains: z.array(z.string()).optional(),
        excludedDomains: z.array(z.string()).optional(),
        language: z.string().optional(),
        country: z.string().optional(),
        freshness: z.string().optional(),
      })
      .optional(),
  })
  .strict();

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
