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
import { createHash } from "node:crypto";
import type { ExpectedInvoice, ExpectedOutcome } from "@/lib/eval/types";

// Build-safe local re-implementation of pinchy-email's `handleFor`
// (id-handle-store.ts). The production `next build` stage copies plugin
// MANIFESTS but not plugin `.ts` source, yet next build type-checks all of
// `packages/web` — so nothing here (scenario, orchestrator, fake-ollama) may
// import the plugin source. This mirrors the plugin's deterministic handle
// (sha256 of the real id, first 16 hex, prefixed); `handle-parity.test.ts`
// (excluded from the build under `src/**/*.test.ts`) asserts they stay equal.
export const EVAL_MSG_PREFIX = "msg";
export const EVAL_ATT_PREFIX = "att";
export function evalHandleFor(realId: string, prefix: string): string {
  return `${prefix}_${createHash("sha256").update(realId).digest("hex").slice(0, 16)}`;
}

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

/**
 * The handles the pinchy-email plugin deterministically mints for the seeded
 * message/attachment ids. Both the orchestrator's normalizer (id-fidelity
 * grading) and the fake-ollama self-test's scripted email_read /
 * email_get_attachment steps use these exact values.
 */
export const HETZNER_ISSUED_MSG_HANDLE = evalHandleFor(HETZNER_SEEDED_MESSAGE_ID, EVAL_MSG_PREFIX);
export const HETZNER_ISSUED_ATT_HANDLE = evalHandleFor(
  HETZNER_SEEDED_ATTACHMENT_ID,
  EVAL_ATT_PREFIX
);

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
  // The seeded res.partner id (see HETZNER_ODOO_BASELINE) — odoo_create
  // resolves the vendor name to this id, and the account.move read-back
  // carries it as a bare number.
  vendorPartnerId: 501,
  invoiceNumber: HETZNER_INVOICE_NUMBER,
  invoiceDate: HETZNER_INVOICE_DATE,
  amountTotal: HETZNER_INVOICE_AMOUNT,
};

export interface HetznerInvoiceScenario {
  seededMessageId: string;
  seededAttachmentId: string;
  issuedMessageHandle: string;
  issuedAttachmentHandle: string;
  graphSeedMessage: typeof HETZNER_GRAPH_SEED_MESSAGE;
  /**
   * Additional inbox messages seeded ALONGSIDE `graphSeedMessage` before
   * dispatch. Used by the distractor scenario to plant plausible-but-wrong
   * emails (e.g. a payment reminder for a different invoice) that the agent
   * must NOT file. Defaults to none. Same shape as `graphSeedMessage`.
   */
  extraGraphMessages?: (typeof HETZNER_GRAPH_SEED_MESSAGE)[];
  /**
   * The plugin-issued message/attachment handles for `extraGraphMessages`, so
   * `gradeIdFidelity` treats reading those extra emails as legitimate (see
   * `normalize.buildTrajectory`). Compute with `evalHandleFor`. Default none.
   */
  extraIssuedMessageHandles?: string[];
  extraIssuedAttachmentHandles?: string[];
  odooBaseline: typeof HETZNER_ODOO_BASELINE;
  userPrompt: string;
  expected: ExpectedInvoice;
  /**
   * The expected end state a successful run produces, used by
   * `gradeRunForScenario` (src/lib/eval/graders.ts) to pick a grading mode.
   * This base scenario expects the vendor bill to actually be created; see
   * `hetzner-invoice-rejected.ts` for the failure-injection counterpart
   * ("honest-failure").
   */
  expectedOutcome: ExpectedOutcome;
}

export const hetznerInvoiceScenario: HetznerInvoiceScenario = {
  seededMessageId: HETZNER_SEEDED_MESSAGE_ID,
  seededAttachmentId: HETZNER_SEEDED_ATTACHMENT_ID,
  issuedMessageHandle: HETZNER_ISSUED_MSG_HANDLE,
  issuedAttachmentHandle: HETZNER_ISSUED_ATT_HANDLE,
  graphSeedMessage: HETZNER_GRAPH_SEED_MESSAGE,
  odooBaseline: HETZNER_ODOO_BASELINE,
  userPrompt: HETZNER_USER_PROMPT,
  expected: HETZNER_EXPECTED_INVOICE,
  expectedOutcome: "vendor-bill-created",
};
