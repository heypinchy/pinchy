/**
 * Pure graders for a single agent run of the Eval-v1 "Hetzner invoice" task
 * (pinchy#669). Every grader is a pure function over a normalized
 * `RunTrajectory` — no I/O, no audit-row parsing — so they are trivially
 * unit-testable with hand-built fixtures. The orchestrator that turns live
 * audit rows into a `RunTrajectory` is a separate, later task.
 */
import type { ExpectedInvoice, FailureTag, GraderResult, RunResult, RunTrajectory } from "./types";

const AMOUNT_TOLERANCE = 0.01;

/** Tool params keys, per tool name, that carry an id/handle the model must have been issued. */
const ID_CONSUMING_PARAMS: Record<string, string[]> = {
  email_read: ["id"],
  email_get_attachment: ["messageId", "attachmentId"],
};

/**
 * Phrases claiming the invoice was entered/created/recorded. Kept as a
 * tunable list (rather than a single regex) so new phrasing can be added
 * without touching grader logic. Matched case-insensitively as substrings.
 */
export const POSITIVE_COMPLETION_PHRASES: string[] = [
  "entered the invoice",
  "created the invoice",
  "recorded the invoice",
  "invoice has been entered",
  "invoice has been created",
  "invoice has been recorded",
  "invoice recorded",
  "invoice created",
  "invoice entered",
  "successfully created",
  "successfully entered",
  "successfully recorded",
];

/**
 * Reasoning/chain-of-thought markers that must never leak into user-facing
 * text or tool params. Named constant so the marker list is reviewable and
 * extensible independent of `detectThinkingLeak`'s logic.
 */
export const THINKING_LEAK_MARKERS: string[] = ["<think", "</think", "reasoning:"];

/**
 * Inability/refusal phrases. Matched case-insensitively as substrings.
 */
export const REFUSAL_PHRASES: string[] = [
  "i can't",
  "i cannot",
  "unable to",
  "i don't have access",
  "i do not have access",
  "i'm not able to",
  "i am not able to",
];

function passResult(): GraderResult {
  return { passed: true, tags: [], notes: [] };
}

function failResult(tag: FailureTag, note: string): GraderResult {
  return { passed: false, tags: [tag], notes: [note] };
}

/**
 * Does the read-back `partner_id` correspond to the expected vendor? Odoo
 * accepts several shapes and the mock stores whatever the plugin sent:
 * - `[id, name]` many2one tuple → match on the display name;
 * - a bare display-name string → match the name directly;
 * - a bare numeric id (Odoo's create read-back after name→id resolution, the
 *   real case here) → the name isn't recoverable from the record, so match the
 *   seeded `expected.vendorPartnerId` when provided, else accept a present id.
 */
function partnerMatches(partnerId: unknown, expected: ExpectedInvoice): boolean {
  if (Array.isArray(partnerId) && typeof partnerId[1] === "string") {
    return partnerId[1] === expected.vendorName;
  }
  if (typeof partnerId === "string") {
    return partnerId === expected.vendorName;
  }
  if (typeof partnerId === "number") {
    return expected.vendorPartnerId === undefined || partnerId === expected.vendorPartnerId;
  }
  return false;
}

/**
 * Did the agent enter the vendor bill correctly? Grading splits by what the
 * agent DIRECTLY controls and the task specifies unambiguously vs. a DERIVED
 * field:
 * - No in_invoice move at all -> task-incomplete (hard fail).
 * - Wrong identity field (vendor / invoice-number / date) -> wrong-field-
 *   extraction (hard fail). Date is normalized across Odoo's `invoice_date`
 *   and `date` columns (models use either; the task means "the right date").
 * - Amount missing/wrong -> amount-not-captured, a SOFT signal that does NOT
 *   fail the run: `amount_total` is a computed field in Odoo (from line_ids),
 *   and a v1 scenario without chart-of-accounts scaffolding can't fairly
 *   require full line-item entry. This follows the eval-design evidence
 *   (component scoring for multi-part tasks; asserting a computed field a mock
 *   doesn't reproduce is a "Database Accuracy" defect, not a model signal).
 *   A v2 scenario should seed accounts, require line items, have the mock
 *   compute the total, and assert the full state (τ-bench gold-replay).
 */
export function gradeTaskCompletion(traj: RunTrajectory, expected: ExpectedInvoice): GraderResult {
  const invoiceMoves = traj.odooMoves.filter((m) => m.move_type === "in_invoice");
  if (invoiceMoves.length === 0) {
    return failResult("task-incomplete", "No in_invoice move found in odooMoves.");
  }

  // Prefer a move that matches on ref (the most specific identifier) if one
  // exists, otherwise grade the first in_invoice move found.
  const move = invoiceMoves.find((m) => m.ref === expected.invoiceNumber) ?? invoiceMoves[0];

  const idMismatches: string[] = [];

  if (move.ref !== expected.invoiceNumber) {
    idMismatches.push(`ref: expected "${expected.invoiceNumber}", got "${String(move.ref)}"`);
  }
  // account.move carries both `invoice_date` (invoice-specific) and `date`
  // (accounting/posting date); either legitimately holds the invoice date.
  const moveDate = move.invoice_date ?? move.date;
  if (moveDate !== expected.invoiceDate) {
    idMismatches.push(
      `date: expected "${expected.invoiceDate}", got ${JSON.stringify(move.invoice_date ?? move.date)}`
    );
  }
  if (!partnerMatches(move.partner_id, expected)) {
    const expectedDesc =
      expected.vendorPartnerId === undefined
        ? `"${expected.vendorName}"`
        : `"${expected.vendorName}" (id ${expected.vendorPartnerId})`;
    idMismatches.push(
      `vendor/partner: expected ${expectedDesc}, got ${JSON.stringify(move.partner_id)}`
    );
  }

  if (idMismatches.length > 0) {
    return { passed: false, tags: ["wrong-field-extraction"], notes: idMismatches };
  }

  // Soft, non-gating: derived amount field (see the docstring).
  const amountOk =
    typeof move.amount_total === "number" &&
    Math.abs(move.amount_total - expected.amountTotal) <= AMOUNT_TOLERANCE;
  if (!amountOk) {
    return {
      passed: true,
      tags: ["amount-not-captured"],
      notes: [
        `amount_total: expected ${expected.amountTotal}, got ${String(
          move.amount_total
        )} (soft signal — derived field, not gated in v1)`,
      ],
    };
  }

  return passResult();
}

/**
 * Regression guard for Bug A: a tool call with a non-empty `error` but
 * `outcome === "success"` means the tool actually failed but was logged as
 * success.
 */
export function gradeAuditHonesty(traj: RunTrajectory): GraderResult {
  const offenders = traj.toolCalls.filter((c) => c.outcome === "success" && !!c.error);
  if (offenders.length === 0) return passResult();
  return {
    passed: false,
    tags: ["false-success"],
    notes: offenders.map(
      (c) => `${c.name} logged outcome=success but had error: ${String(c.error)}`
    ),
  };
}

/**
 * Regression guard for Bug B (handle-indirection). Walks toolCalls in order,
 * accumulating the set of ids/handles the model has been ISSUED so far. For
 * calls that consume an id (email_read/email_get_attachment), a non-empty
 * consumed id that was never issued is corruption.
 */
export function gradeIdFidelity(traj: RunTrajectory): GraderResult {
  const issued = new Set<string>();
  const notes: string[] = [];

  for (const call of traj.toolCalls) {
    const consumingKeys = ID_CONSUMING_PARAMS[call.name];
    if (consumingKeys) {
      for (const key of consumingKeys) {
        const value = call.params[key];
        if (typeof value === "string" && value.length > 0 && !issued.has(value)) {
          const truncated = value.length > 60 ? `${value.slice(0, 60)}...` : value;
          notes.push(`${call.name}.${key} consumed unissued id "${truncated}"`);
        }
      }
    }

    for (const id of call.issuedIds ?? []) {
      issued.add(id);
    }
  }

  if (notes.length === 0) return passResult();
  return { passed: false, tags: ["id-malformed"], notes };
}

/**
 * Does `finalMessage` claim the invoice was entered/created/recorded while
 * NO matching in_invoice move exists?
 */
export function gradeFalseSuccessClaim(traj: RunTrajectory): GraderResult {
  const lowerMessage = traj.finalMessage.toLowerCase();
  const claimsCompletion = POSITIVE_COMPLETION_PHRASES.some((phrase) =>
    lowerMessage.includes(phrase.toLowerCase())
  );
  if (!claimsCompletion) return passResult();

  const hasMove = traj.odooMoves.some((m) => m.move_type === "in_invoice");
  if (hasMove) return passResult();

  return failResult(
    "false-success",
    "finalMessage claims the invoice was entered/created/recorded, but no in_invoice move exists."
  );
}

/** Same tool `name` + deep-equal `params` invoked >= 3 times. */
export function detectLoop(traj: RunTrajectory): GraderResult {
  const counts = new Map<string, number>();
  for (const call of traj.toolCalls) {
    const key = `${call.name}::${JSON.stringify(sortKeysDeep(call.params))}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const loops = [...counts.entries()].filter(([, count]) => count >= 3);
  if (loops.length === 0) return passResult();

  return {
    passed: false,
    tags: ["tool-result-not-recognized"],
    notes: loops.map(([key, count]) => {
      const [name] = key.split("::");
      return `${name} invoked ${count} times with identical params (possible loop)`;
    }),
  };
}

/** Deterministically stringify-friendly key ordering so deep-equal params compare stably. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeysDeep(v)]));
  }
  return value;
}

function containsThinkingLeakMarker(text: string): boolean {
  const lower = text.toLowerCase();
  return THINKING_LEAK_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
}

/**
 * Reasoning/CoT markers leaking into user-facing output: finalMessage or any
 * toolCall.params string value.
 */
export function detectThinkingLeak(traj: RunTrajectory): GraderResult {
  if (containsThinkingLeakMarker(traj.finalMessage)) {
    return failResult("thinking-leaked", "finalMessage contains a reasoning/CoT marker.");
  }

  for (const call of traj.toolCalls) {
    for (const [key, value] of Object.entries(call.params)) {
      if (typeof value === "string" && containsThinkingLeakMarker(value)) {
        return failResult(
          "thinking-leaked",
          `${call.name}.${key} contains a reasoning/CoT marker.`
        );
      }
    }
  }

  return passResult();
}

/**
 * Zero tool calls AND finalMessage matches an inability/refusal phrase.
 */
export function detectRefusal(traj: RunTrajectory): GraderResult {
  if (traj.toolCalls.length > 0) return passResult();

  const lowerMessage = traj.finalMessage.toLowerCase();
  const refused = REFUSAL_PHRASES.some((phrase) => lowerMessage.includes(phrase.toLowerCase()));
  if (!refused) return passResult();

  return failResult("refused-tool", "No tool calls were made and finalMessage refuses the task.");
}

/**
 * Composes all graders. `passed` is true only if every grader passes. `tags`
 * is the de-duplicated union of all failing graders' tags, in a stable order
 * matching grader execution order.
 */
export function gradeRun(traj: RunTrajectory, expected: ExpectedInvoice): RunResult {
  const results = [
    gradeTaskCompletion(traj, expected),
    gradeAuditHonesty(traj),
    gradeIdFidelity(traj),
    gradeFalseSuccessClaim(traj),
    detectLoop(traj),
    detectThinkingLeak(traj),
    detectRefusal(traj),
  ];

  const passed = results.every((r) => r.passed);
  const tags: FailureTag[] = [];
  const tagSet = new Set<FailureTag>();
  const notes: string[] = [];

  for (const result of results) {
    for (const tag of result.tags) {
      if (!tagSet.has(tag)) {
        tagSet.add(tag);
        tags.push(tag);
      }
    }
    notes.push(...result.notes);
  }

  return {
    model: traj.model,
    passed,
    tags,
    notes,
    latencyMs: traj.latencyMs,
    tokens: traj.tokens,
  };
}
