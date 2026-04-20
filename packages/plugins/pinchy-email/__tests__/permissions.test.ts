import { describe, it, expect } from "vitest";
import { checkPermission, getPermittedOperations, type Permissions } from "../permissions";

describe("checkPermission", () => {
  const permissions: Permissions = { email: ["read", "draft"] };

  it("returns true for allowed operation", () => {
    expect(checkPermission(permissions, "email", "read")).toBe(true);
    expect(checkPermission(permissions, "email", "draft")).toBe(true);
  });

  it("returns false for denied operation", () => {
    expect(checkPermission(permissions, "email", "send")).toBe(false);
  });

  it("returns false for unknown model", () => {
    expect(checkPermission(permissions, "calendar", "read")).toBe(false);
  });

  it("returns false for empty permissions", () => {
    expect(checkPermission({}, "email", "read")).toBe(false);
  });
});

describe("getPermittedOperations", () => {
  it("returns operations for a model", () => {
    const permissions: Permissions = { email: ["read", "draft", "send"] };
    expect(getPermittedOperations(permissions, "email")).toEqual(["read", "draft", "send"]);
  });

  it("returns empty array for unknown model", () => {
    expect(getPermittedOperations({}, "email")).toEqual([]);
  });
});
