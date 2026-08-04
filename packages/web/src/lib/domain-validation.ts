import { z } from "zod";

import { normalizeHost } from "./domain-cache";
import { isPathUnderDataRoot } from "./knowledge/citation-path";

// Each label: 1-63 chars, alphanumeric + hyphens (not leading/trailing hyphen).
// At least two labels required (no bare "localhost" etc.).
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function isValidDomain(domain: string): boolean {
  return DOMAIN_RE.test(domain.toLowerCase());
}

/**
 * The form of `host` that is safe to store as the domain lock's target, or
 * `null` when it is not a `Host` value at all.
 *
 * Deliberately more permissive than `isValidDomain` above, and for a
 * different reason: a locked domain is the request's own `Host`/
 * `X-Forwarded-Host` value, not a public production domain an agent is
 * allowed to browse. A real Host value legitimately carries a port (a
 * reverse proxy terminating on a non-default port, or the integration
 * suite locking to its own "localhost:7779" baseURL so subsequent
 * requests keep matching) and can be a bare single-label host. Loosening
 * `isValidDomain` itself to accept those would also loosen the
 * `pinchy-web` allowedDomains/excludedDomains allow-list, which has a
 * different, tighter, SSRF-relevant job.
 *
 * What still MUST be rejected: anything that isn't a bare `Host` value —
 * markup, whitespace, a path/userinfo/query/fragment suffix, or any
 * other character `Host` cannot carry. That combination (injection into
 * the Access Denied page, plus storing a value the request that "proved"
 * it can never send verbatim) is exactly the risk this function exists to
 * close.
 *
 * Round-tripping through `URL` is the check: parse `https://<host>` and
 * require the result's `.host` to equal the input. A mismatch means the input
 * carried something `Host` cannot (a path, an `@`, a `#`, a `?`, or
 * characters the URL parser silently dropped/moved), which is precisely what
 * must not be persisted verbatim.
 *
 * It returns the parsed host rather than a yes/no, and that is the load-bearing
 * part. The comparison has to tolerate the two differences that are pure
 * canonicalisation — case, and a default `:443` — because both are things a
 * real `Host` carries and both are things `isHostAllowed` folds away when it
 * later matches a request against what we stored. Answering "valid" on a
 * normalised reading and then storing the un-normalised input is how a lock
 * stops matching the browser that created it:
 *
 *   - `normalizeHost` folds ports but NOT case, so a lock created from
 *     `Host: EXAMPLE.COM` would never again equal the lowercase Host a browser
 *     sends.
 *   - a proxy configured with `$host:$server_port` sends `example.com:443`,
 *     which the gate matches perfectly well — so refusing to store it turns a
 *     working deployment into a 400 with no way forward.
 *
 * Storing the parse answers both. It does not weaken the check: the equality
 * is still required, only read through the same folding the gate uses, so
 * `evil.com@attacker.com:443` (which parses to a host that is not what
 * arrived) still fails.
 */
export function normalizeLockableHost(host: string): string | null {
  if (!host) return null;
  let parsed: string;
  try {
    parsed = new URL(`https://${host}`).host;
  } catch {
    return null;
  }
  if (!parsed) return null;
  return normalizeHost(parsed) === normalizeHost(host.toLowerCase()) ? parsed : null;
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
