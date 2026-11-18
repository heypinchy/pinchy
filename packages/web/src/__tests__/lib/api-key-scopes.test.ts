import { describe, it, expect } from "vitest";
import { API_KEY_SCOPES, extractScopes, mapScopes, parsePermissions } from "@/lib/api-key-scopes";

/**
 * Unit tests for `mapScopes` — the inverse of `extractScopes` (#572, Task 5.1).
 *
 * `extractScopes` already has coverage in `with-api-key.test.ts` (permissions
 * → scopes, for `withApiKey`'s own needs). This file covers the new
 * direction — scopes → permissions — plus the round-trip property that ties
 * both functions together: whatever `mapScopes` produces must be exactly
 * what `extractScopes` reads back, for every scope Pinchy defines.
 */
describe("mapScopes", () => {
  it("groups flat scope strings into a resource -> actions permissions map", () => {
    expect(mapScopes(["agents:read", "agents:write"])).toEqual({
      agents: ["read", "write"],
    });
  });

  it("collects multiple actions for the same resource into one array", () => {
    expect(mapScopes(["agents:read", "agents:write", "agents:delete"])).toEqual({
      agents: ["read", "write", "delete"],
    });
  });

  it("returns an empty object for an empty scopes array", () => {
    expect(mapScopes([])).toEqual({});
  });

  it("round-trips through extractScopes for the full API_KEY_SCOPES set", () => {
    // The whole point of mapScopes is to be the exact inverse of
    // extractScopes — a scope that goes in as a flat string must come back
    // out unchanged (order aside) after being folded into better-auth's
    // { resource: action[] } permissions shape and unfolded again.
    const allScopes = [...API_KEY_SCOPES];

    const roundTripped = extractScopes(mapScopes(allScopes));

    expect([...roundTripped].sort()).toEqual([...allScopes].sort());
  });
});

/**
 * Unit tests for `parsePermissions` (#572, org-wide GET /api/settings/api-keys).
 *
 * `apiKeys.permissions` (db/schema.ts) is a `text` column — better-auth's own
 * `listApiKeys` endpoint auto-parses it, but a direct Drizzle read (which the
 * org-wide list route uses to bypass the session-scoped plugin endpoint)
 * returns the raw JSON string as-is. `parsePermissions` bridges that gap so
 * `extractScopes` keeps receiving the `Record<resource, action[]>` shape it
 * expects.
 */
describe("parsePermissions", () => {
  it("parses a JSON permissions string into a resource -> actions map", () => {
    expect(parsePermissions('{"agents":["read","write"]}')).toEqual({
      agents: ["read", "write"],
    });
  });

  it("returns null for a null column (a key with no permissions row value)", () => {
    expect(parsePermissions(null)).toBeNull();
  });

  it("returns null for invalid JSON instead of throwing (never crashes the list)", () => {
    expect(parsePermissions("{not-valid-json")).toBeNull();
  });

  it("round-trips with mapScopes/extractScopes through JSON.stringify, exactly as the apikey column would", () => {
    const scopes = [...API_KEY_SCOPES];
    const raw = JSON.stringify(mapScopes(scopes));

    const roundTripped = extractScopes(parsePermissions(raw));

    expect([...roundTripped].sort()).toEqual([...scopes].sort());
  });
});
