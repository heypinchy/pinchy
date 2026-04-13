import { describe, it, expect } from "vitest";
import {
  checkPermission,
  getPermittedEntities,
  type Permissions,
} from "../permissions";

describe("checkPermission", () => {
  const permissions: Permissions = {
    deals: ["read"],
    persons: ["read", "write"],
  };

  it("allows a permitted operation", () => {
    expect(checkPermission(permissions, "deals", "read")).toBe(true);
  });

  it("allows multiple permitted operations on the same entity", () => {
    expect(checkPermission(permissions, "persons", "read")).toBe(true);
    expect(checkPermission(permissions, "persons", "write")).toBe(true);
  });

  it("denies an unpermitted operation on a known entity", () => {
    expect(checkPermission(permissions, "deals", "write")).toBe(false);
  });

  it("denies any operation on an unknown entity", () => {
    expect(checkPermission(permissions, "activities", "read")).toBe(false);
  });

  it("denies everything with empty permissions", () => {
    expect(checkPermission({}, "deals", "read")).toBe(false);
  });
});

describe("getPermittedEntities", () => {
  const permissions: Permissions = {
    deals: ["read"],
    persons: ["read", "write"],
    activities: ["write"],
  };

  it("returns entities that have the given operation", () => {
    expect(getPermittedEntities(permissions, "read")).toEqual([
      "deals",
      "persons",
    ]);
  });

  it("filters correctly for write operation", () => {
    expect(getPermittedEntities(permissions, "write")).toEqual([
      "persons",
      "activities",
    ]);
  });

  it("returns empty array for an operation no entity has", () => {
    expect(getPermittedEntities(permissions, "delete")).toEqual([]);
  });

  it("returns empty array for empty permissions", () => {
    expect(getPermittedEntities({}, "read")).toEqual([]);
  });
});
