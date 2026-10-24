import { describe, it, expect } from "vitest";
import {
  ODOO_OPERATION_TOOLS,
  ODOO_MODEL_AGNOSTIC_TOOLS,
  getOdooTools,
  odooToolsForOperation,
} from "@/lib/tool-registry";

/**
 * The Odoo permission matrix is (model × read|create|write|delete). #1133 gives
 * each cell a third state — "ask" — which has to be stored as a confirmation
 * key per TOOL (`odoo_delete:account.move`), because that is what the gate
 * matches on. So a cell needs to know which tools it speaks for.
 *
 * That mapping is the one hand-maintained list this feature could not avoid,
 * and AGENTS.md is unambiguous about what happens to those: the lists with a
 * guard stay correct, the ones without drift. The failure here is quiet in the
 * dangerous direction — a new Odoo tool nobody classified is a tool the "ask"
 * state cannot reach, so an admin who set a cell to "ask" gets an unconfirmed
 * call and no indication that anything is missing.
 */
describe("Odoo operation → tool mapping", () => {
  it("classifies every Odoo tool exactly once", () => {
    const classified = new Set([
      ...Object.values(ODOO_OPERATION_TOOLS).flat(),
      ...ODOO_MODEL_AGNOSTIC_TOOLS,
    ]);
    const unclassified = getOdooTools()
      .filter((t) => !t.deprecated)
      .map((t) => t.id)
      .filter((id) => !classified.has(id));

    expect(
      unclassified,
      `Odoo tools with no operation: ${unclassified.join(", ")}. Add each to ` +
        `ODOO_OPERATION_TOOLS (it acts on a model) or ODOO_MODEL_AGNOSTIC_TOOLS ` +
        `(it does not), or the per-model "ask" state cannot reach it.`
    ).toEqual([]);
  });

  it("puts no tool in two operations", () => {
    const all = Object.values(ODOO_OPERATION_TOOLS).flat();
    expect(all).toHaveLength(new Set(all).size);
  });

  it("never classifies a model-agnostic tool as an operation too", () => {
    const ops = new Set(Object.values(ODOO_OPERATION_TOOLS).flat());
    expect(ODOO_MODEL_AGNOSTIC_TOOLS.filter((id) => ops.has(id))).toEqual([]);
  });

  // The record-action tools (odoo_confirm_order, odoo_validate_picking, …) all
  // mutate an existing record. Filing them anywhere but `write` would put them
  // under a cell an admin never associates with them.
  it("files the record-action tools under write", () => {
    expect(odooToolsForOperation("write")).toContain("odoo_confirm_order");
    expect(odooToolsForOperation("write")).toContain("odoo_reconcile");
    expect(odooToolsForOperation("write")).toContain("odoo_validate_picking");
  });

  it("keeps create, write and delete apart", () => {
    expect(odooToolsForOperation("create")).toEqual(["odoo_create"]);
    expect(odooToolsForOperation("delete")).toEqual(["odoo_delete"]);
    expect(odooToolsForOperation("write")).not.toContain("odoo_create");
    expect(odooToolsForOperation("write")).not.toContain("odoo_delete");
  });

  // odoo_list_models / odoo_describe_model answer questions about the schema
  // itself, so there is no model row they belong to.
  it("treats the schema tools as model-agnostic", () => {
    expect(ODOO_MODEL_AGNOSTIC_TOOLS).toContain("odoo_list_models");
    expect(ODOO_MODEL_AGNOSTIC_TOOLS).toContain("odoo_describe_model");
  });

  it("files the reading tools under read", () => {
    expect(odooToolsForOperation("read")).toContain("odoo_read");
    expect(odooToolsForOperation("read")).toContain("odoo_count");
    expect(odooToolsForOperation("read")).toContain("odoo_aggregate");
  });
});
