import { describe, it, expect } from "vitest";
import { checkPermission, getPermittedModels, type Permissions } from "../permissions";

describe("checkPermission", () => {
  const permissions: Permissions = {
    "sale.order": ["read"],
    "res.partner": ["read", "write"],
  };

  it("allows a permitted operation", () => {
    expect(checkPermission(permissions, "sale.order", "read")).toBe(true);
  });

  it("allows multiple permitted operations on the same model", () => {
    expect(checkPermission(permissions, "res.partner", "read")).toBe(true);
    expect(checkPermission(permissions, "res.partner", "write")).toBe(true);
  });

  it("denies an unpermitted operation on a known model", () => {
    expect(checkPermission(permissions, "sale.order", "write")).toBe(false);
  });

  it("denies any operation on an unknown model", () => {
    expect(checkPermission(permissions, "account.move", "read")).toBe(false);
  });

  it("denies everything with empty permissions", () => {
    expect(checkPermission({}, "sale.order", "read")).toBe(false);
  });
});

describe("getPermittedModels", () => {
  const permissions: Permissions = {
    "sale.order": ["read"],
    "res.partner": ["read", "write"],
    "account.move": ["write"],
  };

  it("returns models that have the given operation", () => {
    expect(getPermittedModels(permissions, "read")).toEqual([
      "sale.order",
      "res.partner",
    ]);
  });

  it("filters correctly for write operation", () => {
    expect(getPermittedModels(permissions, "write")).toEqual([
      "res.partner",
      "account.move",
    ]);
  });

  it("returns empty array for an operation no model has", () => {
    expect(getPermittedModels(permissions, "delete")).toEqual([]);
  });

  it("returns empty array for empty permissions", () => {
    expect(getPermittedModels({}, "read")).toEqual([]);
  });
});
