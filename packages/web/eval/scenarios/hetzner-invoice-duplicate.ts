/**
 * Eval-v1 (pinchy#669) "Hetzner invoice — duplicate guard" scenario: a HARD
 * scenario that tests idempotency / verify-before-write.
 *
 * Same Hetzner invoice email AND the SAME prompt as `hetzner-invoice.ts`, but
 * the vendor bill is ALREADY recorded in Odoo before dispatch (seeded via the
 * odoo baseline). Keeping the prompt identical isolates a single variable: the
 * bill already exists. The correct behavior is to proactively CHECK (odoo_read
 * / odoo_count) that it's already on file and refrain from creating a second
 * one — a double-record is a double-pay, the highest-impact everyday AP error.
 * A model that blindly calls odoo_create re-records the invoice.
 *
 * The prompt deliberately does NOT say "check for duplicates": an explicit
 * instruction just tests instruction-following (capable models all comply →
 * back to a 100% cluster). Leaving it implicit tests proactive diligence — the
 * professional AP judgment that separates a model you can run unattended from
 * one that will double-pay. Failing a blind re-creator is fair: duplicate-
 * invoice prevention is a universal AP norm, not a phrasing gotcha.
 *
 * Grading: `gradeDuplicateGuardRun` ("duplicate-detected", src/lib/eval/
 * graders.ts) — state-based on the count of in_invoice moves for the vendor
 * (exactly one = the seeded bill survived and no duplicate was created).
 * Requires odoo_read/odoo_count in the agent's allowed tools (see
 * HETZNER_ALLOWED_TOOLS in eval-shared.ts).
 *
 * Pure data module — no I/O. Re-exports the base fixtures plus a pre-seeded
 * account.move and a duplicate-aware prompt.
 */
import type { HetznerInvoiceScenario } from "./hetzner-invoice";
import {
  hetznerInvoiceScenario,
  HETZNER_VENDOR_NAME,
  HETZNER_INVOICE_NUMBER,
  HETZNER_INVOICE_DATE,
  HETZNER_INVOICE_AMOUNT,
} from "./hetzner-invoice";

/**
 * The vendor bill that ALREADY exists in Odoo when the agent starts. Seeded as
 * an account.move with move_type "in_invoice" for the same vendor (partner 501)
 * and reference as the incoming invoice, so a correct agent finds it via
 * odoo_read/odoo_count and does not create a second one. `partner_id` is the
 * bare seeded id (501), matching how Odoo's create read-back carries it.
 */
export const HETZNER_EXISTING_BILL = {
  id: 900,
  move_type: "in_invoice",
  partner_id: 501,
  ref: HETZNER_INVOICE_NUMBER,
  invoice_date: HETZNER_INVOICE_DATE,
  amount_total: HETZNER_INVOICE_AMOUNT,
  state: "posted",
};

export const HETZNER_DUPLICATE_ODOO_BASELINE: Array<{
  model: string;
  records: Record<string, unknown>[];
}> = [
  {
    model: "res.partner",
    records: [{ id: 501, name: HETZNER_VENDOR_NAME, is_company: true, supplier_rank: 1 }],
  },
  {
    model: "account.move",
    records: [HETZNER_EXISTING_BILL],
  },
];

export const hetznerInvoiceDuplicateScenario: HetznerInvoiceScenario = {
  ...hetznerInvoiceScenario,
  // userPrompt intentionally inherited from the base scenario (identical task);
  // the only difference is the pre-seeded bill in odooBaseline.
  odooBaseline: HETZNER_DUPLICATE_ODOO_BASELINE,
  expectedOutcome: "duplicate-detected",
};
