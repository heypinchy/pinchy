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

/**
 * Parse the raw JSON string better-auth stores in the `apikey.permissions`
 * column (db/schema.ts: `permissions: text("permissions")` — deliberately
 * NOT jsonb, see that column's comment) into the `Record<resource,
 * action[]>` shape `extractScopes` expects.
 *
 * `auth.api.listApiKeys` auto-parses this column for its callers, but a
 * direct Drizzle read does not. `GET /api/settings/api-keys` (#572, org-wide
 * list) reads the table directly — bypassing that session-scoped endpoint —
 * so it needs this parse step itself.
 *
 * Returns `null` for a null/empty column or invalid JSON — never throws, so
 * one corrupt/legacy row degrades to "no scopes" (`extractScopes(null)` →
 * `[]`) instead of crashing the whole list.
 */
export function parsePermissions(raw: string | null): Record<string, string[]> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, string[]>;
  } catch {
    return null;
  }
}

/**
 * The inverse of `extractScopes`: fold Pinchy's flat scope strings into
 * better-auth's `permissions: Record<resource, action[]>` shape, so a route
 * can hand `auth.api.createApiKey` the grants it actually understands.
 *
 * Used by `POST /api/settings/api-keys` (#572, Task 5.1) to turn a request's
 * validated `scopes: ApiKeyScope[]` into the `permissions` body field.
 */
export function mapScopes(scopes: ApiKeyScope[]): Record<string, string[]> {
  const permissions: Record<string, string[]> = {};
  for (const scope of scopes) {
    // `resource` is always the left half of a validated ApiKeyScope (a
    // closed union from API_KEY_SCOPES, e.g. always "agents" today), never
    // arbitrary user input — .split(":") just widens the type to `string`.
    const [resource, action] = scope.split(":");
    // eslint-disable-next-line security/detect-object-injection
    (permissions[resource] ??= []).push(action);
  }
  return permissions;
}
