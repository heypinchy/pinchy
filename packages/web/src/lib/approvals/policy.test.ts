import { describe, it, expect } from "vitest";
import { getConfirmTools, defaultConfirmTools } from "./policy";

describe("getConfirmTools", () => {
  it("returns the configured confirm tools", () => {
    expect(getConfirmTools({ "pinchy-approvals": { confirmTools: ["odoo_write"] } })).toEqual([
      "odoo_write",
    ]);
  });

  it("returns [] when unset or null", () => {
    expect(getConfirmTools(null)).toEqual([]);
    expect(getConfirmTools(undefined)).toEqual([]);
    expect(getConfirmTools({})).toEqual([]);
  });
});

describe("defaultConfirmTools", () => {
  it("selects only the agent's powerful tools (real registry)", () => {
    // odoo_write is powerful; odoo_list_models is safe (read-only).
    const result = defaultConfirmTools(["odoo_write", "odoo_list_models"]);
    expect(result).toContain("odoo_write");
    expect(result).not.toContain("odoo_list_models");
  });

  it("ignores tool ids the agent is not allowed to use", () => {
    expect(defaultConfirmTools([])).toEqual([]);
  });

  it("ignores unknown tool ids not in the registry", () => {
    expect(defaultConfirmTools(["not_a_real_tool"])).toEqual([]);
  });
});
