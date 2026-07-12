/**
 * Eval-v1 (pinchy#669) "Hetzner invoice — duplicate guard" scenario: a HARD
 * scenario that tests idempotency / verify-before-write.
 *
 * Same Hetzner invoice email as `hetzner-invoice.ts`, but the vendor bill is
 * ALREADY recorded in Odoo before dispatch (seeded via the odoo baseline). The
 * prompt asks the agent to file the invoice while making sure it isn't
 * double-recorded. The correct behavior is to CHECK (odoo_read / odoo_count for
 * an existing account.move with this reference) and refrain from creating a
 * second bill — a double-record is a double-pay, the highest-impact everyday AP
 * error. A model that blindly calls odoo_create re-records the invoice.
 *
 * This deliberately breaks the happy-path 100% cluster: the easy scenario hands
 * the model a single clean create; this one demands a proactive verify-then-
 * decide step that capable-on-easy models routinely skip. Realistic, not
 * contrived — duplicate-invoice prevention is a core AP control.
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

export const HETZNER_DUPLICATE_USER_PROMPT =
  "A Hetzner invoice just arrived by email. Before creating anything in Odoo, " +
  "check whether this invoice is already recorded as a vendor bill — we must " +
  "never double-record (and double-pay) an invoice. If it is already there, do " +
  "NOT create a duplicate; just confirm it's already on file. Only if it is " +
  "missing should you file it as a new vendor bill.";

export const hetznerInvoiceDuplicateScenario: HetznerInvoiceScenario = {
  ...hetznerInvoiceScenario,
  odooBaseline: HETZNER_DUPLICATE_ODOO_BASELINE,
  userPrompt: HETZNER_DUPLICATE_USER_PROMPT,
  expectedOutcome: "duplicate-detected",
};
