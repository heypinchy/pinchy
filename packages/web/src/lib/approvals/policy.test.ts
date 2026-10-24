import { describe, it, expect } from "vitest";
import { getConfirmMap, resolveConfirmation, defaultConfirmMap, toolIsConfigured } from "./policy";

describe("getConfirmMap", () => {
  it("returns the configured map", () => {
    expect(getConfirmMap({ "pinchy-approvals": { confirm: { odoo_write: "confirm" } } })).toEqual({
      odoo_write: "confirm",
    });
  });

  it("returns {} when unset or null", () => {
    expect(getConfirmMap(null)).toEqual({});
    expect(getConfirmMap(undefined)).toEqual({});
    expect(getConfirmMap({})).toEqual({});
  });

  // AGENTS.md § "Test Migrations Against Pre-Existing Data". Every agent whose
  // admin turned confirmation on before #1133 carries `confirmTools`, and this
  // is the read side of the switch: without the fallback the map comes back
  // empty, the gate allows, and a policy an admin set silently stops applying.
  // Loudly wrong would be survivable; this failure mode looks like success.
  it("reads a pre-#1133 confirmTools list when no map has been written", () => {
    expect(
      getConfirmMap({ "pinchy-approvals": { confirmTools: ["odoo_write", "email_send"] } })
    ).toEqual({ odoo_write: "confirm", email_send: "confirm" });
  });

  // The distinction the fallback turns on: `confirm: {}` is an admin who
  // migrated and gated nothing, `confirm: undefined` is an agent that has not
  // been saved since the upgrade. Falling back on the former would resurrect a
  // policy the admin deliberately cleared.
  it("does not fall back once a map exists, even an empty one", () => {
    expect(
      getConfirmMap({ "pinchy-approvals": { confirm: {}, confirmTools: ["odoo_write"] } })
    ).toEqual({});
  });
});

describe("resolveConfirmation", () => {
  const cfg = (confirm: Record<string, "confirm" | "allow">) => ({
    "pinchy-approvals": { confirm },
  });

  it("allows a tool nobody gated", () => {
    expect(resolveConfirmation(cfg({}), "odoo_write", [])).toBe("allow");
  });

  it("confirms a gated tool with no model in play", () => {
    expect(resolveConfirmation(cfg({ email_send: "confirm" }), "email_send", [])).toBe("confirm");
  });

  it("lets an explicit model exception override the tool setting", () => {
    const c = cfg({ odoo_delete: "confirm", "odoo_delete:note.note": "allow" });
    expect(resolveConfirmation(c, "odoo_delete", ["note.note"])).toBe("allow");
    expect(resolveConfirmation(c, "odoo_delete", ["account.move"])).toBe("confirm");
  });

  it("gates a single model while the tool itself is ungated", () => {
    const c = cfg({ "odoo_write:account.move": "confirm" });
    expect(resolveConfirmation(c, "odoo_write", ["account.move"])).toBe("confirm");
    expect(resolveConfirmation(c, "odoo_write", ["res.partner"])).toBe("allow");
  });

  // The rule that keeps the control safe. "odoo_delete requires confirmation"
  // covers every model, including ones nobody has heard of yet; a per-model
  // grid only covers cells someone touched. If an untouched cell defaulted to
  // allow, a model added next month would be silently ungated for an admin who
  // believes deletion is gated — the allowlist failure mode AGENTS.md keeps
  // naming: a positive list cannot report what is not in it.
  it("makes an untouched model cell inherit the tool setting, never allow", () => {
    const c = cfg({ odoo_delete: "confirm", "odoo_delete:note.note": "allow" });
    expect(resolveConfirmation(c, "odoo_delete", ["a.model.added.later"])).toBe("confirm");
  });

  // odoo_reconcile touches account.move AND account.payment. Without a stated
  // rule the behaviour of a call spanning a gated and an ungated model is
  // undefined, and "undefined" resolves to whichever the loop happens to see.
  it("takes the strictest setting when a call spans several models", () => {
    const c = cfg({ "odoo_write:account.move": "confirm", "odoo_write:res.partner": "allow" });
    expect(resolveConfirmation(c, "odoo_write", ["res.partner", "account.move"])).toBe("confirm");
    expect(resolveConfirmation(c, "odoo_write", ["account.move", "res.partner"])).toBe("confirm");
  });

  // A ref the model garbled decodes to nothing, but the call still acts on
  // something. Reading that as "no resource" would drop it to the tool level
  // silently; reading it as a cell nobody configured makes it inherit — same
  // answer, arrived at by the rule that is written down.
  it("makes an unnamed resource inherit the tool setting", () => {
    expect(resolveConfirmation(cfg({ odoo_write: "confirm" }), "odoo_write", [null])).toBe(
      "confirm"
    );
    expect(resolveConfirmation(cfg({}), "odoo_write", [null])).toBe("allow");
  });

  it("still confirms when one of several resources cannot be named", () => {
    const c = cfg({ odoo_reconcile: "confirm", "odoo_reconcile:account.payment": "allow" });
    expect(resolveConfirmation(c, "odoo_reconcile", ["account.payment", null])).toBe("confirm");
  });

  it("resolves a pre-#1133 config at the tool level", () => {
    const legacy = { "pinchy-approvals": { confirmTools: ["odoo_delete"] } };
    expect(resolveConfirmation(legacy, "odoo_delete", ["account.move"])).toBe("confirm");
    expect(resolveConfirmation(legacy, "odoo_write", ["account.move"])).toBe("allow");
  });
});

const cfgWith = (confirm: Record<string, "confirm" | "allow">) => ({
  "pinchy-approvals": { confirm },
});

describe("toolIsConfigured", () => {
  it("sees a tool-level setting", () => {
    expect(
      toolIsConfigured({ "pinchy-approvals": { confirm: { odoo_write: "confirm" } } }, "odoo_write")
    ).toBe(true);
  });

  // The short-circuit must not skip a tool that is only gated on one model —
  // that would make every per-model exception a no-op, silently.
  it("sees a tool that only appears in a resource cell", () => {
    const cfg = cfgWith({ "odoo_write:account.move": "confirm" });
    expect(toolIsConfigured(cfg, "odoo_write")).toBe(true);
  });

  it("does not match a tool whose name merely prefixes another", () => {
    const cfg = cfgWith({ odoo_write_off: "confirm" });
    expect(toolIsConfigured(cfg, "odoo_write")).toBe(false);
  });

  it("sees a pre-#1133 confirmTools entry", () => {
    expect(
      toolIsConfigured({ "pinchy-approvals": { confirmTools: ["email_send"] } }, "email_send")
    ).toBe(true);
  });

  it("is false for an unmentioned tool", () => {
    expect(toolIsConfigured({ "pinchy-approvals": { confirm: {} } }, "odoo_write")).toBe(false);
    expect(toolIsConfigured(null, "odoo_write")).toBe(false);
  });
});

describe("defaultConfirmMap", () => {
  it("selects only the agent's powerful tools (real registry)", () => {
    // odoo_write is powerful; odoo_list_models is safe (read-only).
    const result = defaultConfirmMap(["odoo_write", "odoo_list_models"]);
    expect(result).toEqual({ odoo_write: "confirm" });
  });

  it("ignores tool ids the agent is not allowed to use", () => {
    expect(defaultConfirmMap([])).toEqual({});
  });

  it("ignores unknown tool ids not in the registry", () => {
    expect(defaultConfirmMap(["not_a_real_tool"])).toEqual({});
  });
});
