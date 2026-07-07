/**
 * Eval-v1 (pinchy#669) "Hetzner invoice" scenario: read an invoice email,
 * download its PDF attachment, and enter it into Odoo as a vendor bill.
 *
 * Pure data module — no I/O. The orchestrator (`packages/web/eval/run-eval.ts`)
 * seeds these fixtures into the Graph mock / Odoo mock and dispatches
 * `userPrompt` to the agent under test.
 *
 * Invoice fields (vendor, invoice number, date, amount) are placed in the
 * email BODY as plain readable text, not only inside the PDF — this
 * deliberately isolates tool-loop reliability (list -> read -> download ->
 * create) from OCR/PDF-extraction accuracy, which is a separate concern.
 */
import type { ExpectedInvoice } from "@/lib/eval/types";

/**
 * A ~150-char base64url-ish blob mirroring the shape of a real Microsoft
 * Graph message id (`AAMkAG...` prefix). Fixed (not random) so the scenario
 * is reproducible across runs and the computed handle in the self-test
 * fixtures stays stable.
 */
export const HETZNER_SEEDED_MESSAGE_ID =
  "AAMkAGI1ZDk3ZGI4LTk3NmYtNDNlNC1iOTk3LWQ0ZTE2ZjczYTI4MgBGAAAAAACx3universalHetznerScenarioMessageIdFixtureAAAKAAAAAAA=";

export const HETZNER_SEEDED_ATTACHMENT_ID =
  "AAMkAGI1ZDk3ZGI4LTk3NmYtNDNlNC1iOTk3LWQ0ZTE2ZjczYTI4MgBGAAAAAACx3universalHetznerScenarioAttachmentIdFixtureAKAAAAAAA=";

export const HETZNER_INVOICE_SUBJECT = "Rechnung R0012345678";
export const HETZNER_INVOICE_FROM = "billing@hetzner.com";
export const HETZNER_VENDOR_NAME = "Hetzner Online GmbH";
export const HETZNER_INVOICE_NUMBER = "R0012345678";
export const HETZNER_INVOICE_DATE = "2026-06-30";
export const HETZNER_INVOICE_AMOUNT = 47.6;

export const HETZNER_INVOICE_BODY = `Hetzner Online GmbH

Rechnung / Invoice

Invoice number: ${HETZNER_INVOICE_NUMBER}
Invoice date: ${HETZNER_INVOICE_DATE}
Vendor: ${HETZNER_VENDOR_NAME}
Amount due: EUR ${HETZNER_INVOICE_AMOUNT.toFixed(2)}

Dear customer,

please find attached the invoice for your Hetzner Cloud services for the
past billing period. The amount of EUR ${HETZNER_INVOICE_AMOUNT.toFixed(2)} will be collected via your
registered payment method.

Hetzner Online GmbH
Industriestr. 25
91710 Gunzenhausen
Germany`;

/**
 * A minimal, valid, single-page PDF ("Hetzner Online GmbH - Rechnung
 * R0012345678", amount 47.60 EUR rendered as text) so `email_get_attachment`
 * exercises a real download/save round trip. Deliberately tiny — the eval
 * isolates tool-loop reliability from PDF/OCR extraction fidelity, so the
 * scenario's ground truth lives in the email body, not the PDF content.
 */
export const HETZNER_ATTACHMENT_PDF_BASE64 =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMjAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggMTAwID4+CnN0cmVhbQpCVCAvRjEgMTIgVGYgMjAgMTUwIFRkIChIZXR6bmVyIE9ubGluZSBHbWJIIC0gUmVjaG51bmcgUjAwMTIzNDU2NzgpIFRqIEVUCkJUIC9GMSAxMiBUZiAyMCAxMzAgVGQgKERhdHVtOiAyMDI2LTA2LTMwICBCZXRyYWc6IDQ3LjYwIEVVUikgVGogRVQKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNgp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjAKJSVFT0Y=";

export const HETZNER_ATTACHMENT_FILENAME = "rechnung.pdf";
export const HETZNER_ATTACHMENT_CONTENT_TYPE = "application/pdf";

/**
 * Graph-mock seed message shape, matching `seedGraphMockMessages` in
 * `packages/web/e2e/email/helpers.ts`.
 */
export const HETZNER_GRAPH_SEED_MESSAGE = {
  id: HETZNER_SEEDED_MESSAGE_ID,
  subject: HETZNER_INVOICE_SUBJECT,
  from: HETZNER_INVOICE_FROM,
  body: HETZNER_INVOICE_BODY,
  isRead: false,
  hasAttachments: true,
  attachments: [
    {
      "@odata.type": "#microsoft.graph.fileAttachment",
      id: HETZNER_SEEDED_ATTACHMENT_ID,
      name: HETZNER_ATTACHMENT_FILENAME,
      contentType: HETZNER_ATTACHMENT_CONTENT_TYPE,
      size: Math.ceil((HETZNER_ATTACHMENT_PDF_BASE64.length * 3) / 4),
      isInline: false,
      contentBytes: HETZNER_ATTACHMENT_PDF_BASE64,
    },
  ],
};

/**
 * Odoo baseline records to seed BEFORE dispatch, matching
 * `seedOdooRecords(model, records)` in `packages/web/e2e/odoo/helpers.ts`.
 * A pre-existing `res.partner` for the vendor lets `odoo_create`'s
 * many2one-name resolution find `partner_id` by exact display name without
 * requiring the model to also invent a new partner.
 */
export const HETZNER_ODOO_BASELINE: Array<{
  model: string;
  records: Record<string, unknown>[];
}> = [
  {
    model: "res.partner",
    records: [{ id: 501, name: HETZNER_VENDOR_NAME, is_company: true, supplier_rank: 1 }],
  },
];

export const HETZNER_USER_PROMPT =
  "Read the latest invoice email from Hetzner and enter it into Odoo as a vendor bill.";

export const HETZNER_EXPECTED_INVOICE: ExpectedInvoice = {
  vendorName: HETZNER_VENDOR_NAME,
  invoiceNumber: HETZNER_INVOICE_NUMBER,
  invoiceDate: HETZNER_INVOICE_DATE,
  amountTotal: HETZNER_INVOICE_AMOUNT,
};

export interface HetznerInvoiceScenario {
  seededMessageId: string;
  seededAttachmentId: string;
  graphSeedMessage: typeof HETZNER_GRAPH_SEED_MESSAGE;
  odooBaseline: typeof HETZNER_ODOO_BASELINE;
  userPrompt: string;
  expected: ExpectedInvoice;
}

export const hetznerInvoiceScenario: HetznerInvoiceScenario = {
  seededMessageId: HETZNER_SEEDED_MESSAGE_ID,
  seededAttachmentId: HETZNER_SEEDED_ATTACHMENT_ID,
  graphSeedMessage: HETZNER_GRAPH_SEED_MESSAGE,
  odooBaseline: HETZNER_ODOO_BASELINE,
  userPrompt: HETZNER_USER_PROMPT,
  expected: HETZNER_EXPECTED_INVOICE,
};
