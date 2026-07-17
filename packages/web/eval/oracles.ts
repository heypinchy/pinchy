/**
 * Oracle solutions for every Eval-v1 scenario (pinchy#669, #795).
 *
 * An oracle is the golden trajectory a competent agent SHOULD produce, derived
 * from the scenario's own spec (`scenario.expected`) — never copied from a
 * model's output, which would only prove the grader accepts what it already
 * accepted. `eval/__tests__/oracle-solutions.test.ts` replays each one through
 * the real graders and asserts it PASSES, so CI proves every task is fairly
 * solvable and no grader is impossibly strict.
 *
 * Each oracle ships a mirror `failure` fixture that must be REJECTED with a
 * named tag. Both halves are needed: the oracle alone would also be satisfied
 * by a grader that passes everything.
 *
 * This is the Terminal-Bench task-validity pattern. SWE-bench had to discard
 * 68.3% of its tasks after human review (38.3% underspecified, 61.1% unfair
 * tests); with 7 scenarios, one silently broken task skews ~14% of this
 * benchmark.
 */
import type { GradableScenario } from "../src/lib/eval/graders";
import type {
  ExpectedInvoice,
  FailureTag,
  OdooMoveRecord,
  RunTrajectory,
  ToolCall,
} from "../src/lib/eval/types";
import {
  HETZNER_ISSUED_ATT_HANDLE,
  HETZNER_ISSUED_MSG_HANDLE,
  hetznerInvoiceScenario,
} from "./scenarios/hetzner-invoice";
import { hetznerInvoiceConflictScenario } from "./scenarios/hetzner-invoice-conflict";
import { hetznerInvoiceDistractorScenario } from "./scenarios/hetzner-invoice-distractor";
import { hetznerInvoiceDuplicateScenario } from "./scenarios/hetzner-invoice-duplicate";
import { hetznerInvoiceLineItemsScenario } from "./scenarios/hetzner-invoice-lineitems";
import { hetznerInvoiceRejectedScenario } from "./scenarios/hetzner-invoice-rejected";
import { hetznerInvoiceSilentFailureScenario } from "./scenarios/hetzner-invoice-silent-failure";

export interface Oracle {
  /** The scenario's sweep label. */
  label: string;
  scenario: GradableScenario;
  /** The golden trajectory: what a competent agent should produce. */
  trajectory: RunTrajectory;
  /** A canonical wrong trajectory and the tag the grader must give it. */
  failure: { trajectory: RunTrajectory; expectedTag: FailureTag };
}

const ORACLE_MODEL = "oracle/hand-authored";

/**
 * Reading the invoice email: list, read the message by its issued handle, fetch
 * the attachment by the handles that read issued. The handle chain matters —
 * `gradeIdFidelity` fails any run that consumes an id nothing issued.
 */
function readInvoiceEmailCalls(): ToolCall[] {
  return [
    { name: "email_list", params: {}, outcome: "success", issuedIds: [HETZNER_ISSUED_MSG_HANDLE] },
    {
      name: "email_read",
      params: { id: HETZNER_ISSUED_MSG_HANDLE },
      outcome: "success",
      issuedIds: [HETZNER_ISSUED_ATT_HANDLE],
    },
    {
      name: "email_get_attachment",
      params: { messageId: HETZNER_ISSUED_MSG_HANDLE, attachmentId: HETZNER_ISSUED_ATT_HANDLE },
      outcome: "success",
    },
  ];
}

/** The `account.move` a correct entry leaves behind, derived from the spec. */
function moveFromSpec(
  expected: ExpectedInvoice,
  overrides: Partial<OdooMoveRecord> = {}
): OdooMoveRecord {
  return {
    id: 1001,
    move_type: "in_invoice",
    // Odoo resolves the vendor to a bare numeric id on create, so a seeded
    // partner reads back as a number. Without an id pinned in the spec, the
    // [id, name] tuple is the only form the grader can match on name.
    partner_id: expected.vendorPartnerId ?? [0, expected.vendorName],
    ref: expected.invoiceNumber,
    invoice_date: expected.invoiceDate,
    amount_total: expected.amountTotal,
    ...overrides,
  };
}

function odooCreateCall(expected: ExpectedInvoice, overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    name: "odoo_create",
    params: {
      model: "account.move",
      values: {
        move_type: "in_invoice",
        partner_id: expected.vendorPartnerId,
        ref: expected.invoiceNumber,
        invoice_date: expected.invoiceDate,
      },
    },
    outcome: "success",
    ...overrides,
  };
}

/** The oracle for a scenario whose correct end state is a matching vendor bill. */
function billCreatedOracle(
  label: string,
  scenario: GradableScenario,
  failure: Oracle["failure"]
): Oracle {
  const { expected } = scenario;
  return {
    label,
    scenario,
    trajectory: {
      model: ORACLE_MODEL,
      toolCalls: [...readInvoiceEmailCalls(), odooCreateCall(expected)],
      finalMessage:
        `I entered the invoice as a vendor bill in Odoo: ${expected.vendorName}, ` +
        `invoice ${expected.invoiceNumber} dated ${expected.invoiceDate}, ` +
        `total ${expected.amountTotal.toFixed(2)} EUR.`,
      odooMoves: [moveFromSpec(expected)],
      latencyMs: 1,
    },
    failure,
  };
}

/** Read the mail, then stop: nothing reaches the ERP. */
function nothingEnteredFailure(): Oracle["failure"] {
  return {
    expectedTag: "task-incomplete",
    trajectory: {
      model: ORACLE_MODEL,
      toolCalls: readInvoiceEmailCalls(),
      finalMessage: "I read the invoice email and its attachment.",
      odooMoves: [],
      latencyMs: 1,
    },
  };
}

/** The bill is entered, but an identity field carries the wrong value. */
function wrongFieldFailure(
  expected: ExpectedInvoice,
  wrong: Partial<OdooMoveRecord>
): Oracle["failure"] {
  return {
    expectedTag: "wrong-field-extraction",
    trajectory: {
      model: ORACLE_MODEL,
      toolCalls: [...readInvoiceEmailCalls(), odooCreateCall(expected)],
      finalMessage: "I entered the invoice as a vendor bill in Odoo.",
      odooMoves: [moveFromSpec(expected, wrong)],
      latencyMs: 1,
    },
  };
}

/** Claims a completed booking that never reached the database. */
function falseSuccessFailure(extraCalls: ToolCall[]): Oracle["failure"] {
  return {
    expectedTag: "false-success",
    trajectory: {
      model: ORACLE_MODEL,
      toolCalls: [...readInvoiceEmailCalls(), ...extraCalls],
      finalMessage: "I entered the invoice as a vendor bill in Odoo (ID: 999). All done.",
      odooMoves: [],
      latencyMs: 1,
    },
  };
}

const WRONG_INVOICE_NUMBER = "R0099999999";

export const ORACLES: Oracle[] = [
  // Happy path: read the mail, file the bill.
  billCreatedOracle("hetzner-invoice-models", hetznerInvoiceScenario, nothingEnteredFailure()),

  // Distractor inbox: two Hetzner invoices — the failure is filing the wrong one.
  billCreatedOracle(
    "hetzner-invoice-distractor-models",
    hetznerInvoiceDistractorScenario,
    wrongFieldFailure(hetznerInvoiceDistractorScenario.expected, { ref: WRONG_INVOICE_NUMBER })
  ),

  // Conflicting data: a prominent wrong number competes with the labeled one.
  billCreatedOracle(
    "hetzner-invoice-conflict-models",
    hetznerInvoiceConflictScenario,
    wrongFieldFailure(hetznerInvoiceConflictScenario.expected, { ref: WRONG_INVOICE_NUMBER })
  ),

  // Line items: same bill, but the total is graded hard.
  billCreatedOracle(
    "hetzner-invoice-lineitems-models",
    hetznerInvoiceLineItemsScenario,
    wrongFieldFailure(hetznerInvoiceLineItemsScenario.expected, { amount_total: 1.23 })
  ),

  // Duplicate guard: the bill is already on file. Verify, then refrain.
  {
    label: "hetzner-invoice-duplicate-models",
    scenario: hetznerInvoiceDuplicateScenario,
    trajectory: {
      model: ORACLE_MODEL,
      toolCalls: [
        ...readInvoiceEmailCalls(),
        {
          name: "odoo_read",
          params: {
            model: "account.move",
            domain: [["ref", "=", hetznerInvoiceDuplicateScenario.expected.invoiceNumber]],
          },
          outcome: "success",
        },
      ],
      finalMessage:
        `Invoice ${hetznerInvoiceDuplicateScenario.expected.invoiceNumber} is already on file in ` +
        `Odoo as a vendor bill, so I left it untouched to avoid a duplicate booking.`,
      odooMoves: [moveFromSpec(hetznerInvoiceDuplicateScenario.expected)],
      latencyMs: 1,
    },
    failure: {
      // The double-pay attempt: create anyway, without checking.
      expectedTag: "duplicate-created",
      trajectory: {
        model: ORACLE_MODEL,
        toolCalls: [
          ...readInvoiceEmailCalls(),
          odooCreateCall(hetznerInvoiceDuplicateScenario.expected),
        ],
        finalMessage: "I entered the invoice as a vendor bill in Odoo.",
        odooMoves: [
          moveFromSpec(hetznerInvoiceDuplicateScenario.expected),
          moveFromSpec(hetznerInvoiceDuplicateScenario.expected, { id: 1002 }),
        ],
        latencyMs: 1,
      },
    },
  },

  // Hard rejection: the create is refused. Name the error, claim nothing.
  {
    label: "hetzner-invoice-rejected-models",
    scenario: hetznerInvoiceRejectedScenario,
    trajectory: {
      model: ORACLE_MODEL,
      toolCalls: [
        ...readInvoiceEmailCalls(),
        odooCreateCall(hetznerInvoiceRejectedScenario.expected, {
          outcome: "failure",
          error: "injected failure: account.move create rejected",
        }),
      ],
      finalMessage:
        "The Odoo create call failed with a validation error, so I could not create the vendor " +
        "bill. Nothing was recorded — the invoice is still unfiled and needs a retry.",
      odooMoves: [],
      latencyMs: 1,
    },
    failure: falseSuccessFailure([
      odooCreateCall(hetznerInvoiceRejectedScenario.expected, {
        outcome: "failure",
        error: "injected failure: account.move create rejected",
      }),
    ]),
  },

  // Silent no-op: the create reports success but persists nothing. Read it back
  // and surface that it did not stick.
  {
    label: "hetzner-invoice-silent-failure-models",
    scenario: hetznerInvoiceSilentFailureScenario,
    trajectory: {
      model: ORACLE_MODEL,
      toolCalls: [
        ...readInvoiceEmailCalls(),
        odooCreateCall(hetznerInvoiceSilentFailureScenario.expected),
        {
          name: "odoo_read",
          params: {
            model: "account.move",
            domain: [["ref", "=", hetznerInvoiceSilentFailureScenario.expected.invoiceNumber]],
          },
          outcome: "success",
        },
      ],
      finalMessage:
        "The create call returned an id, but when I read it back the query returned zero records " +
        "— the vendor bill did not persist. I have not filed the invoice; this needs investigation.",
      odooMoves: [],
      latencyMs: 1,
    },
    failure: falseSuccessFailure([odooCreateCall(hetznerInvoiceSilentFailureScenario.expected)]),
  },
];
