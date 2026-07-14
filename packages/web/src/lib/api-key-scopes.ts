/**
 * API-key scopes for the Agent Provisioning API (#572).
 *
 * A scope is a `"<resource>:<action>"` string. better-auth stores a key's
 * grants as `permissions: Record<resource, action[]>` (e.g.
 * `{ agents: ["read", "write"] }`); Pinchy's wrappers reason in flat scope
 * strings. `extractScopes` bridges the two.
 */
export const API_KEY_SCOPES = ["agents:read", "agents:write", "agents:delete"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

const KNOWN_SCOPES: ReadonlySet<string> = new Set(API_KEY_SCOPES);

/**
 * Flatten better-auth's `permissions` map into the flat scope strings Pinchy
 * uses, keeping only strings that are valid `API_KEY_SCOPES`.
 *
 * Filtering (rather than passing through) is deliberate: an unknown or stale
 * permission (say `agents:admin`, or a resource we no longer recognize) must
 * never leak into an `ApiKeyContext` as if it were a granted capability. The
 * return type is therefore honestly `ApiKeyScope[]`.
 *
 * Returns `[]` for `null`/`undefined` (a key with no permissions grants
 * nothing).
 */
export function extractScopes(
  permissions: Record<string, string[]> | null | undefined
): ApiKeyScope[] {
  if (!permissions) return [];
  const scopes: ApiKeyScope[] = [];
  for (const [resource, actions] of Object.entries(permissions)) {
    if (!Array.isArray(actions)) continue;
    for (const action of actions) {
      const scope = `${resource}:${action}`;
      if (KNOWN_SCOPES.has(scope)) {
        scopes.push(scope as ApiKeyScope);
      }
    }
  }
  return scopes;
}
