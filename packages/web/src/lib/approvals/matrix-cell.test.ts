import { describe, it, expect } from "vitest";
import { cellStateFor, applyCellState } from "./matrix-cell";
import type { ConfirmMap } from "./policy";

describe("cellStateFor", () => {
  it("is off when the operation is not granted, whatever the policy says", () => {
    expect(cellStateFor({ odoo_delete: "confirm" }, "account.move", "delete", false)).toBe("off");
  });

  it("is allow when nothing gates the tool", () => {
    expect(cellStateFor({}, "account.move", "delete", true)).toBe("allow");
  });

  // The inheritance made visible. An admin who gated odoo_delete at tool level
  // should see every delete cell reading "ask" without having ticked each one —
  // a blank cell would misdescribe what the gate is going to do.
  it("shows a cell nobody touched as what it inherits", () => {
    expect(cellStateFor({ odoo_delete: "confirm" }, "a.new.model", "delete", true)).toBe("ask");
  });

  it("shows an explicit exception over the inherited value", () => {
    const confirm: ConfirmMap = { odoo_delete: "confirm", "odoo_delete:note.note": "allow" };
    expect(cellStateFor(confirm, "note.note", "delete", true)).toBe("allow");
    expect(cellStateFor(confirm, "account.move", "delete", true)).toBe("ask");
  });

  // `write` speaks for odoo_write plus every record action. If one of them
  // still pauses, the honest reading is "ask" — claiming "allow" would be the
  // looser of the two, on a security control.
  it("reads ask when any tool of a multi-tool column would ask", () => {
    const confirm: ConfirmMap = { "odoo_reconcile:account.move": "confirm" };
    expect(cellStateFor(confirm, "account.move", "write", true)).toBe("ask");
  });
});

describe("applyCellState", () => {
  it("writes an ask key for every tool the column speaks for", () => {
    const next = applyCellState({}, "account.move", "write", "ask");
    expect(next["odoo_write:account.move"]).toBe("confirm");
    expect(next["odoo_reconcile:account.move"]).toBe("confirm");
    expect(next["odoo_confirm_order:account.move"]).toBe("confirm");
  });

  // The exception the whole feature exists for. Clearing the key instead would
  // resolve back to the tool-level "ask", so "just do it for a note" would
  // quietly not take effect.
  it("writes an explicit allow that survives a gated tool level", () => {
    const next = applyCellState({ odoo_delete: "confirm" }, "note.note", "delete", "allow");
    expect(next["odoo_delete:note.note"]).toBe("allow");
    expect(cellStateFor(next, "note.note", "delete", true)).toBe("allow");
    expect(cellStateFor(next, "account.move", "delete", true)).toBe("ask");
  });

  it("touches no other model's keys", () => {
    const next = applyCellState(
      { "odoo_delete:note.note": "allow" },
      "account.move",
      "delete",
      "ask"
    );
    expect(next["odoo_delete:note.note"]).toBe("allow");
  });

  it("leaves the map alone when the cell is turned off", () => {
    const confirm: ConfirmMap = { "odoo_delete:note.note": "allow" };
    expect(applyCellState(confirm, "note.note", "delete", "off")).toEqual(confirm);
  });
});
