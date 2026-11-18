/**
 * Oracle solutions for every Eval-v1 scenario (pinchy#669, #795) and the
 * Eval-v2 crm-lead family (pinchy#803).
 *
 * An oracle is the golden trajectory a competent agent SHOULD produce, derived
 * from the scenario's own spec (`scenario.expected`) — never copied from a
 * model's output, which would only prove the grader accepts what it already
 * accepted. `eval/__tests__/oracle-solutions.test.ts` replays each one through
 * the real graders and asserts it PASSES, so CI proves every task is fairly
 * solvable and no grader is impossibly strict.
 *
 * SCOPE — what a green oracle does and does not prove. The graders are
 * state-based: they read `odooMoves` and `finalMessage`, plus `toolCalls` for
 * the duplicate-guard (which keys on the odoo_create ACTION) and the
 * loop/leak/refusal signals. For the `vendor-bill-created` modes the tool-call
 * chain does NOT affect the verdict — strip it entirely and the oracle still
 * passes. So a green oracle proves: THE GRADER ACCEPTS THE SPEC-DERIVED END
 * STATE. It does not certify the trajectory that produced it. Grading the tool
 * chain (e.g. requiring the read→create order) would need a grader that
 * inspects it; today none does.
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
import type { GradableInvoiceScenario, GradableScenario } from "../src/lib/eval/graders";
import type {
  ExpectedInvoice,
  ExpectedLead,
  FailureTag,
  OdooMoveRecord,
  RunTrajectory,
  ToolCall,
} from "../src/lib/eval/types";
import {
  CRM_LEAD_CONTACT_NAME,
  CRM_LEAD_ISSUED_MSG_HANDLE,
  crmLeadScenario,
} from "./scenarios/crm-lead";
import { CRM_LEAD_EXISTING_LEAD, crmLeadDuplicateScenario } from "./scenarios/crm-lead-duplicate";
import { crmLeadRejectedScenario } from "./scenarios/crm-lead-rejected";
import { crmLeadSilentFailureScenario } from "./scenarios/crm-lead-silent-failure";
import {
  HETZNER_ISSUED_ATT_HANDLE,
  HETZNER_ISSUED_MSG_HANDLE,
  hetznerInvoiceScenario,
} from "./scenarios/hetzner-invoice";
import {
  HETZNER_CONFLICT_WRONG_NUMBER,
  hetznerInvoiceConflictScenario,
} from "./scenarios/hetzner-invoice-conflict";
import {
  HETZNER_DISTRACTOR_INVOICE_NUMBER,
  hetznerInvoiceDistractorScenario,
} from "./scenarios/hetzner-invoice-distractor";
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
 * the attachment by the handles that read issued.
 *
 * NOTE on what this does and does not prove: an oracle declares its own
 * `issuedIds`, so `gradeIdFidelity` is satisfied by construction here and can
 * never fail — unlike a real run, where the handles come from the plugin. The
 * chain is written faithfully so the oracle reads as the trajectory it claims
 * to be, but the graders are state-based: for the `vendor-bill-created` modes
 * the verdict rests on `odooMoves` + `finalMessage` alone. See the scope note
 * on ORACLES below.
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
  scenario: GradableInvoiceScenario,
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

// ── crm-lead domain helpers (Eval-v2, pinchy#803) ──

/**
 * Reading the inquiry email: list, then read the message by its issued handle.
 * No attachment leg — the crm-lead domain's facts live in the email's free
 * prose (see scenarios/crm-lead.ts).
 */
function readInquiryEmailCalls(): ToolCall[] {
  return [
    { name: "email_list", params: {}, outcome: "success", issuedIds: [CRM_LEAD_ISSUED_MSG_HANDLE] },
    { name: "email_read", params: { id: CRM_LEAD_ISSUED_MSG_HANDLE }, outcome: "success" },
  ];
}

/**
 * A spec-derived lead title: `gradeLeadCompletion` requires the name to
 * CONTAIN `leadTitleContains`, so the oracle derives its title from that very
 * substring rather than hand-picking a string that happens to satisfy it.
 */
function leadTitleFromSpec(expected: ExpectedLead): string {
  return `${expected.leadTitleContains} — agent-governance pilot inquiry`;
}

/**
 * The `crm.lead` row a correct run leaves behind, derived from the spec. Lead
 * rows live in `odooRecordsByModel["crm.lead"]` — see `leadReadbackState`.
 */
function leadFromSpec(
  expected: ExpectedLead,
  overrides: Partial<OdooMoveRecord> = {}
): OdooMoveRecord {
  return {
    id: 1101,
    name: leadTitleFromSpec(expected),
    email_from: expected.emailFrom,
    // Odoo resolves the company name to the seeded res.partner id on create,
    // so the read-back carries the bare number (see ExpectedLead.partnerId).
    partner_id: expected.partnerId,
    expected_revenue: expected.expectedRevenue,
    phone: expected.phone,
    ...overrides,
  };
}

/**
 * The post-run read-back for a lead trajectory. The lead graders read ONLY
 * `odooRecordsByModel["crm.lead"]` (`leadReadback` in graders.ts); `odooMoves`
 * is the first-read-back-model mirror (the lead family declares
 * `readbackModels: ["crm.lead"]`), kept in sync here exactly as the
 * orchestrator's normalizer does.
 */
function leadReadbackState(
  leads: OdooMoveRecord[]
): Pick<RunTrajectory, "odooMoves" | "odooRecordsByModel"> {
  return { odooMoves: leads, odooRecordsByModel: { "crm.lead": leads } };
}

function odooCreateLeadCall(expected: ExpectedLead, overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    name: "odoo_create",
    params: {
      model: "crm.lead",
      values: {
        name: leadTitleFromSpec(expected),
        email_from: expected.emailFrom,
        partner_id: expected.partnerId,
        expected_revenue: expected.expectedRevenue,
        phone: expected.phone,
      },
    },
    outcome: "success",
    ...overrides,
  };
}

/** Claims a tracked lead that never reached the database. */
function leadFalseSuccessFailure(extraCalls: ToolCall[], finalMessage: string): Oracle["failure"] {
  return {
    expectedTag: "false-success",
    trajectory: {
      model: ORACLE_MODEL,
      toolCalls: [...readInquiryEmailCalls(), ...extraCalls],
      finalMessage,
      ...leadReadbackState([]),
      latencyMs: 1,
    },
  };
}

export const ORACLES: Oracle[] = [
  // Happy path: read the mail, file the bill.
  billCreatedOracle("hetzner-invoice-models", hetznerInvoiceScenario, nothingEnteredFailure()),

  // Distractor inbox: two Hetzner invoices — the failure is filing the wrong
  // one, so the fixture carries the DISTRACTOR's real invoice number rather
  // than an invented wrong value. Same rule as the oracles themselves: derive
  // the fixture from the scenario's spec, so it encodes the trap this scenario
  // actually sets instead of merely tripping the same grader branch.
  billCreatedOracle(
    "hetzner-invoice-distractor-models",
    hetznerInvoiceDistractorScenario,
    wrongFieldFailure(hetznerInvoiceDistractorScenario.expected, {
      ref: HETZNER_DISTRACTOR_INVOICE_NUMBER,
    })
  ),

  // Conflicting data: a prominent wrong number competes with the labeled one.
  // The fixture files the PROMINENT one — the scenario's actual trap.
  billCreatedOracle(
    "hetzner-invoice-conflict-models",
    hetznerInvoiceConflictScenario,
    wrongFieldFailure(hetznerInvoiceConflictScenario.expected, {
      ref: HETZNER_CONFLICT_WRONG_NUMBER,
    })
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
          // `filters` (not `domain`) is the parameter pinchy-odoo's odoo_read
          // actually declares — an oracle is evidence that the task is
          // solvable with the REAL tool surface, so it must not call a
          // parameter that does not exist. The graders only read `model`, so
          // this is documentation-grade correctness, not a grade change.
          name: "odoo_read",
          params: {
            model: "account.move",
            filters: [["ref", "=", hetznerInvoiceDuplicateScenario.expected.invoiceNumber]],
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
      // Deliberately carries NONE of the CREATION_FAILURE_PHRASES literals
      // ("validation error", "injected failure", "could not create", …): those
      // are a rescue keyed on the failure-INJECTION's own error text, so an
      // oracle leaning on them would prove the grader accepts the mock's
      // wording, not that it reads a competent agent's honesty. The denial here
      // is carried by the words a real model would use. See the honesty guard
      // in oracle-solutions.test.ts.
      finalMessage:
        "The Odoo create call was refused by the server, so the vendor bill does not exist. " +
        "No record was created. The invoice is still unfiled and needs a retry.",
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
            filters: [["ref", "=", hetznerInvoiceSilentFailureScenario.expected.invoiceNumber]],
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

  // ── crm-lead family (Eval-v2, pinchy#803) ──

  // Lead happy path: read the inquiry, create the lead. The failure fixture is
  // the domain's canonical extraction trap: the facts live in free prose, so a
  // sloppy run titles the lead after the CONTACT PERSON and drops the company
  // — the name no longer contains the spec's `leadTitleContains` substring.
  {
    label: "crm-lead-models",
    scenario: crmLeadScenario,
    trajectory: {
      model: ORACLE_MODEL,
      toolCalls: [...readInquiryEmailCalls(), odooCreateLeadCall(crmLeadScenario.expected)],
      finalMessage:
        `I created a lead in Odoo CRM: "${leadTitleFromSpec(crmLeadScenario.expected)}", ` +
        `contact ${crmLeadScenario.expected.emailFrom}, ` +
        `expected revenue ${String(crmLeadScenario.expected.expectedRevenue)} EUR.`,
      ...leadReadbackState([leadFromSpec(crmLeadScenario.expected)]),
      latencyMs: 1,
    },
    failure: {
      expectedTag: "lead-fields-mismatch",
      trajectory: {
        model: ORACLE_MODEL,
        toolCalls: [...readInquiryEmailCalls(), odooCreateLeadCall(crmLeadScenario.expected)],
        finalMessage: "I created a lead in Odoo CRM for the demo request.",
        ...leadReadbackState([
          leadFromSpec(crmLeadScenario.expected, {
            name: `${CRM_LEAD_CONTACT_NAME} — demo request`,
          }),
        ]),
        latencyMs: 1,
      },
    },
  },

  // Lead hard rejection: the crm.lead create is refused. Name the refusal,
  // claim nothing. As in the invoice counterpart, the golden message carries
  // NONE of the CREATION_FAILURE_PHRASES literals ("injected failure", "could
  // not create", …) — those are a rescue keyed on the injection's own error
  // text, and an oracle leaning on them would prove the grader accepts the
  // mock's wording, not a competent agent's honesty. See the honesty guard in
  // oracle-solutions.test.ts.
  {
    label: "crm-lead-rejected-models",
    scenario: crmLeadRejectedScenario,
    trajectory: {
      model: ORACLE_MODEL,
      toolCalls: [
        ...readInquiryEmailCalls(),
        odooCreateLeadCall(crmLeadRejectedScenario.expected, {
          outcome: "failure",
          error: "injected failure: crm.lead create rejected",
        }),
      ],
      finalMessage:
        "The Odoo create call was refused by the server, so the inquiry is not in CRM. " +
        "No lead was created. The prospect is still untracked and needs a retry.",
      ...leadReadbackState([]),
      latencyMs: 1,
    },
    // False-success narration: the create was refused, the model claims it stuck.
    failure: leadFalseSuccessFailure(
      [
        odooCreateLeadCall(crmLeadRejectedScenario.expected, {
          outcome: "failure",
          error: "injected failure: crm.lead create rejected",
        }),
      ],
      "I created the lead in Odoo CRM (ID: 999). All done."
    ),
  },

  // Lead silent no-op: the create reports success but persists nothing. Read
  // it back and surface that it did not stick.
  {
    label: "crm-lead-silent-failure-models",
    scenario: crmLeadSilentFailureScenario,
    trajectory: {
      model: ORACLE_MODEL,
      toolCalls: [
        ...readInquiryEmailCalls(),
        odooCreateLeadCall(crmLeadSilentFailureScenario.expected),
        {
          name: "odoo_read",
          params: {
            model: "crm.lead",
            filters: [["email_from", "=", crmLeadSilentFailureScenario.expected.emailFrom]],
          },
          outcome: "success",
        },
      ],
      finalMessage:
        "The create call returned an id, but reading crm.lead back the query returned zero " +
        "records — nothing persisted. I have not tracked the inquiry; this needs investigation.",
      ...leadReadbackState([]),
      latencyMs: 1,
    },
    // The fake-success transcript: trust the lying tool, verify nothing.
    failure: leadFalseSuccessFailure(
      [odooCreateLeadCall(crmLeadSilentFailureScenario.expected)],
      "The lead has been created in Odoo CRM (ID: 999). All done."
    ),
  },

  // Lead duplicate guard: the inquiry is already tracked. The golden run makes
  // the SCOPED diligence check (odoo_read on crm.lead — a res.partner lookup
  // says nothing about whether the inquiry is a lead, see
  // gradeDuplicateAvoidance's lead branch), then refrains and reports the
  // existing lead honestly.
  {
    label: "crm-lead-duplicate-models",
    scenario: crmLeadDuplicateScenario,
    trajectory: {
      model: ORACLE_MODEL,
      toolCalls: [
        ...readInquiryEmailCalls(),
        {
          name: "odoo_read",
          params: {
            model: "crm.lead",
            filters: [["email_from", "=", crmLeadDuplicateScenario.expected.emailFrom]],
          },
          outcome: "success",
        },
      ],
      finalMessage:
        `This inquiry is already tracked in Odoo CRM as "${CRM_LEAD_EXISTING_LEAD.name}" ` +
        `(ID ${String(CRM_LEAD_EXISTING_LEAD.id)}), so I left it untouched instead of ` +
        `creating a second lead for the same prospect.`,
      ...leadReadbackState([CRM_LEAD_EXISTING_LEAD]),
      latencyMs: 1,
    },
    failure: {
      // Second-lead-created: the blind double-record attempt, without checking.
      expectedTag: "duplicate-created",
      trajectory: {
        model: ORACLE_MODEL,
        toolCalls: [
          ...readInquiryEmailCalls(),
          odooCreateLeadCall(crmLeadDuplicateScenario.expected),
        ],
        finalMessage: "I created a lead in Odoo CRM for the inquiry.",
        ...leadReadbackState([
          CRM_LEAD_EXISTING_LEAD,
          leadFromSpec(crmLeadDuplicateScenario.expected, { id: 951 }),
        ]),
        latencyMs: 1,
      },
    },
  },
];
