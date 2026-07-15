import { describe, it, expect } from "vitest";
import { API_KEY_SCOPES, extractScopes, mapScopes } from "@/lib/api-key-scopes";

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
