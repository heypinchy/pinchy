/**
 * Eval-v1 (pinchy#669) "Hetzner invoice — conflicting data" scenario: a HARD
 * scenario that tests extraction DISCIPLINE under conflicting signals.
 *
 * One invoice email with TWO conflicting-signal traps on hard-graded fields:
 *   - Invoice NUMBER: a wrong number (R0099998877) is the most prominent — it's
 *     in the subject line and a "Reference:" line — while the authoritative,
 *     labeled "Invoice number:" field carries the correct one (R0012345678).
 *   - Invoice DATE: an "Order date" and a "Due date" flank the correct
 *     "Invoice date" (2026-06-30); a model that grabs either wrong date fails.
 * There is deliberately NO "please disregard" cue: the model has to trust the
 * labeled fields over sheer prominence / plausible neighbours. A model that
 * grabs the reference number or the wrong date files a vendor bill with a wrong
 * `ref`/`invoice_date` and fails `gradeTaskCompletion` (wrong-field-extraction).
 *
 * Same attachment/handles/partner and the same happy-path prompt as
 * `hetzner-invoice.ts` — only the email subject and body change, so no new
 * grader and no multi-email handle plumbing are needed. The correct end state
 * is still the R0012345678 Cloud-services bill (HETZNER_EXPECTED_INVOICE).
 *
 * Pure data module — re-exports the base fixtures with a conflicted email.
 */
import type { HetznerInvoiceScenario } from "./hetzner-invoice";
import {
  hetznerInvoiceScenario,
  HETZNER_GRAPH_SEED_MESSAGE,
  HETZNER_VENDOR_NAME,
  HETZNER_INVOICE_NUMBER,
  HETZNER_INVOICE_DATE,
  HETZNER_INVOICE_AMOUNT,
} from "./hetzner-invoice";

/** The prominent WRONG number (an older/other reference), not the invoice to file. */
export const HETZNER_CONFLICT_WRONG_NUMBER = "R0099998877";

export const HETZNER_CONFLICT_SUBJECT = `Rechnung ${HETZNER_CONFLICT_WRONG_NUMBER}`;

export const HETZNER_CONFLICT_BODY = `Hetzner Online GmbH

Rechnung / Invoice

Reference: ${HETZNER_CONFLICT_WRONG_NUMBER}
Invoice number: ${HETZNER_INVOICE_NUMBER}
Order date: 2026-06-15
Invoice date: ${HETZNER_INVOICE_DATE}
Due date: 2026-07-30
Vendor: ${HETZNER_VENDOR_NAME}
Amount due: EUR ${HETZNER_INVOICE_AMOUNT.toFixed(2)}

Dear customer,

please find attached the invoice for your Hetzner Cloud services for the past
billing period. The amount of EUR ${HETZNER_INVOICE_AMOUNT.toFixed(2)} will be collected via your
registered payment method.

Hetzner Online GmbH
Industriestr. 25
91710 Gunzenhausen
Germany`;

/**
 * Same message id/attachment as the base scenario (so the plugin-issued
 * handles are unchanged), only the subject and body carry the conflict.
 */
export const HETZNER_CONFLICT_GRAPH_SEED_MESSAGE = {
  ...HETZNER_GRAPH_SEED_MESSAGE,
  subject: HETZNER_CONFLICT_SUBJECT,
  body: HETZNER_CONFLICT_BODY,
};

export const hetznerInvoiceConflictScenario: HetznerInvoiceScenario = {
  ...hetznerInvoiceScenario,
  graphSeedMessage: HETZNER_CONFLICT_GRAPH_SEED_MESSAGE,
  // userPrompt, odooBaseline, expected (R0012345678), expectedOutcome all
  // inherited — only the email's subject/body introduce the conflict.
};
