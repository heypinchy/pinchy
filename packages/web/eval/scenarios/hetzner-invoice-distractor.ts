/**
 * Eval-v1 (pinchy#669) "Hetzner invoice — distractor inbox" scenario: a HARD
 * scenario that tests grounding / picking the RIGHT document.
 *
 * The inbox holds TWO real Hetzner invoices, both from billing@hetzner.com and
 * both with a PDF attachment, for DIFFERENT services and invoice numbers:
 *   - the target: Hetzner **Cloud services**, R0012345678 (the base scenario's
 *     invoice, €47.60);
 *   - a distractor: Hetzner **Dedicated Server**, R0009998877 (€89.00).
 * Same sender and both look like invoices, so the agent cannot shortcut by
 * sender or by "the one with an attachment" — it has to READ and match the
 * service the prompt asks for.
 *
 * Correct behavior: file the Cloud-services invoice (R0012345678). A model that
 * grabs the dedicated-server invoice files a vendor bill with the wrong `ref`
 * and fails `gradeTaskCompletion` (wrong-field-extraction). Grading reuses the
 * "vendor-bill-created" mode — the trap lives in the DATA (two plausible
 * invoices) and the prompt's target, not in a new grader; the identity-field
 * check catches the mis-selection.
 *
 * `gradeTaskCompletion` prefers the move whose ref matches the target, so a
 * model that files the target passes even if it also spuriously files the
 * distractor. v1 measures "did it pick the right invoice"; a stricter
 * "and nothing else" check can be added if probes show routine double-filing.
 *
 * Pure data module — re-exports the base fixtures plus the distractor invoice.
 */
import type { HetznerInvoiceScenario } from "./hetzner-invoice";
import {
  hetznerInvoiceScenario,
  HETZNER_ATTACHMENT_PDF_BASE64,
  HETZNER_ATTACHMENT_CONTENT_TYPE,
  evalHandleFor,
  EVAL_MSG_PREFIX,
  EVAL_ATT_PREFIX,
} from "./hetzner-invoice";

export const HETZNER_DISTRACTOR_MESSAGE_ID =
  "AAMkAGI1ZDk3ZGI4LTk3NmYtNDNlNC1iOTk3LWQ0ZTE2ZjczYTI4MgBGAAAAAACx3universalHetznerScenarioDistractorInvoiceIdFixtureAAA=";
export const HETZNER_DISTRACTOR_ATTACHMENT_ID =
  "AAMkAGI1ZDk3ZGI4LTk3NmYtNDNlNC1iOTk3LWQ0ZTE2ZjczYTI4MgBGAAAAAACx3universalHetznerScenarioDistractorAttachmentIdFixtA=";

export const HETZNER_DISTRACTOR_INVOICE_NUMBER = "R0009998877";

/**
 * A second, plausible Hetzner invoice — a DIFFERENT product (dedicated server),
 * number and amount. Looks exactly as invoice-like as the real one (same
 * sender, its own PDF), so the only way to pick correctly is to match the
 * service the prompt asks for.
 */
export const HETZNER_DISTRACTOR_MESSAGE = {
  id: HETZNER_DISTRACTOR_MESSAGE_ID,
  subject: "Rechnung R0009998877 — Dedicated Server",
  from: "billing@hetzner.com",
  body: `Hetzner Online GmbH

Rechnung / Invoice

Invoice number: ${HETZNER_DISTRACTOR_INVOICE_NUMBER}
Invoice date: 2026-06-28
Vendor: Hetzner Online GmbH
Amount due: EUR 89.00

Dear customer,

please find attached the invoice for your Hetzner Dedicated Server (EX44) for
the past billing period. The amount of EUR 89.00 will be collected via your
registered payment method.

Hetzner Online GmbH
Industriestr. 25
91710 Gunzenhausen
Germany`,
  isRead: false,
  hasAttachments: true,
  attachments: [
    {
      "@odata.type": "#microsoft.graph.fileAttachment",
      id: HETZNER_DISTRACTOR_ATTACHMENT_ID,
      name: "rechnung-server.pdf",
      contentType: HETZNER_ATTACHMENT_CONTENT_TYPE,
      size: Math.ceil((HETZNER_ATTACHMENT_PDF_BASE64.length * 3) / 4),
      isInline: false,
      contentBytes: HETZNER_ATTACHMENT_PDF_BASE64,
    },
  ],
};

/**
 * Prompt names the target by SERVICE (Cloud services), which only the real
 * invoice matches — so a model must read both bodies to choose correctly.
 */
export const HETZNER_DISTRACTOR_USER_PROMPT =
  "There are a couple of Hetzner invoices in the inbox. Enter the one for our " +
  "Hetzner Cloud services into Odoo as a vendor bill.";

// The plugin-issued handles for the distractor email/attachment, so reading it
// (which a correct model does, to compare) is not mis-flagged as an unissued
// handle by gradeIdFidelity.
export const HETZNER_DISTRACTOR_MSG_HANDLE = evalHandleFor(
  HETZNER_DISTRACTOR_MESSAGE_ID,
  EVAL_MSG_PREFIX
);
export const HETZNER_DISTRACTOR_ATT_HANDLE = evalHandleFor(
  HETZNER_DISTRACTOR_ATTACHMENT_ID,
  EVAL_ATT_PREFIX
);

export const hetznerInvoiceDistractorScenario: HetznerInvoiceScenario = {
  ...hetznerInvoiceScenario,
  extraGraphMessages: [HETZNER_DISTRACTOR_MESSAGE],
  extraIssuedMessageHandles: [HETZNER_DISTRACTOR_MSG_HANDLE],
  extraIssuedAttachmentHandles: [HETZNER_DISTRACTOR_ATT_HANDLE],
  userPrompt: HETZNER_DISTRACTOR_USER_PROMPT,
  // odooBaseline, expected (the Cloud-services invoice), expectedOutcome all
  // inherited — only the inbox and the prompt's target differ.
};
