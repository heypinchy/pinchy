/**
 * Drift guard: every Odoo template that grants create/write on a model X
 * must also grant read on every model X' that X references via a foreign
 * key the agent will realistically need to look up.
 *
 * Concrete example: `account.move.line.account_id` is a many2one to
 * `account.account`. An agent with `create` on `account.move.line` but
 * no `read` on `account.account` cannot enumerate valid GL accounts
 * and ends up either picking IDs at random or asking the user verbally.
 * v0.5.4 release click-through hit this exact gap on the Bookkeeper
 * template ("account.account missing" → bills could not be created
 * without manual UI intervention).
 *
 * FK_DEPS is the source of truth: keep it focused on the common
 * "agent picks a value to set a field" pattern. It's not meant to be
 * an exhaustive Odoo ORM model — leaf many2ones to res.lang or
 * ir.sequence don't belong here.
 */

import { describe, it, expect } from "vitest";
import { ODOO_TEMPLATES } from "@/lib/agent-templates/data/odoo-agents";

const FK_DEPS: Record<string, string[]> = {
  "account.move": [
    "res.partner",
    "account.journal",
    "account.account",
    "account.tax",
    "res.currency",
  ],
  "account.move.line": [
    "account.account",
    "account.tax",
    "account.journal",
    "res.partner",
    "res.currency",
  ],
  "account.payment": ["res.partner", "account.journal", "res.currency"],
  "hr.expense": ["account.account", "res.currency", "product.product", "hr.employee"],
  "hr.expense.sheet": ["hr.expense", "hr.employee"],
  "sale.order": ["res.partner", "product.product", "res.currency", "account.tax"],
  "sale.order.line": ["sale.order", "product.product", "account.tax"],
  "purchase.order": ["res.partner", "product.product", "res.currency"],
  "purchase.order.line": ["purchase.order", "product.product", "account.tax"],
  "stock.picking": ["stock.location", "res.partner", "stock.warehouse"],
  "stock.move": ["product.product", "stock.location"],
  "mrp.production": ["product.product", "stock.warehouse", "mrp.bom"],
  "hr.leave": ["hr.employee", "hr.leave.type"],
  "approval.request": ["approval.category"],
  "crm.lead": ["res.partner", "crm.stage"],
  "project.task": ["project.project", "res.users", "hr.employee"],
};

describe("Odoo template FK dependencies", () => {
  it("every template with create/write on a model also grants read on its FK lookup targets", () => {
    const violations: Array<{ template: string; writes: string; missing: string[] }> = [];

    for (const [id, template] of Object.entries(ODOO_TEMPLATES)) {
      const required = template.odooConfig?.requiredModels ?? [];
      const requiredSet = new Set(required.map((m) => m.model));

      const writeModels = required
        .filter((m) => m.operations.includes("create") || m.operations.includes("write"))
        .map((m) => m.model);

      const missingPerWrite = new Set<string>();
      for (const w of writeModels) {
        const deps = FK_DEPS[w] ?? [];
        for (const d of deps) {
          if (!requiredSet.has(d)) missingPerWrite.add(d);
        }
      }

      if (missingPerWrite.size > 0) {
        violations.push({
          template: id,
          writes: writeModels.join(", "),
          missing: [...missingPerWrite].sort(),
        });
      }
    }

    const message =
      violations.length === 0
        ? ""
        : `\n${violations
            .map(
              (v) =>
                `  - ${v.template}: writes [${v.writes}], missing READ on: [${v.missing.join(", ")}]`
            )
            .join(
              "\n"
            )}\n\nAdd the missing models to the template's requiredModels with operations: ["read"].`;

    expect(violations, message).toEqual([]);
  });
});
