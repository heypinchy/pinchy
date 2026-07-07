import { describe, expect, it } from "vitest";
import {
  detectLoop,
  detectRefusal,
  detectThinkingLeak,
  gradeAuditHonesty,
  gradeFalseSuccessClaim,
  gradeIdFidelity,
  gradeRun,
  gradeTaskCompletion,
} from "../graders";
import type { ExpectedInvoice, RunTrajectory } from "../types";

const EXPECTED: ExpectedInvoice = {
  vendorName: "Hetzner Online GmbH",
  invoiceNumber: "R2026-0042",
  invoiceDate: "2026-06-01",
  amountTotal: 123.45,
};

function baseTrajectory(overrides: Partial<RunTrajectory> = {}): RunTrajectory {
  return {
    model: "test-model",
    toolCalls: [],
    finalMessage: "",
    odooMoves: [],
    latencyMs: 1000,
    ...overrides,
  };
}

const MATCHING_MOVE = {
  id: 1,
  move_type: "in_invoice",
  partner_id: [7, "Hetzner Online GmbH"] as [number, string],
  ref: "R2026-0042",
  invoice_date: "2026-06-01",
  amount_total: 123.45,
};

describe("gradeRun (fully passing trajectory)", () => {
  it("passes with no tags when everything is correct", () => {
    const traj = baseTrajectory({
      toolCalls: [
        {
          name: "email_list",
          params: {},
          outcome: "success",
          issuedIds: ["msg_1"],
        },
        {
          name: "email_read",
          params: { id: "msg_1" },
          outcome: "success",
          issuedIds: ["att_1"],
        },
        {
          name: "email_get_attachment",
          params: { messageId: "msg_1", attachmentId: "att_1" },
          outcome: "success",
        },
        {
          name: "odoo_create",
          params: { model: "account.move", ref: "R2026-0042" },
          outcome: "success",
        },
      ],
      finalMessage: "I've entered the Hetzner invoice into Odoo.",
      odooMoves: [MATCHING_MOVE],
    });

    const result = gradeRun(traj, EXPECTED);
    expect(result.passed).toBe(true);
    expect(result.tags).toEqual([]);
    expect(result.model).toBe("test-model");
    expect(result.latencyMs).toBe(1000);
  });
});

describe("gradeTaskCompletion", () => {
  it("fails with task-incomplete when no in_invoice move exists", () => {
    const traj = baseTrajectory({ odooMoves: [] });
    const result = gradeTaskCompletion(traj, EXPECTED);
    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["task-incomplete"]);
  });

  it("ignores moves that are not in_invoice", () => {
    const traj = baseTrajectory({
      odooMoves: [{ ...MATCHING_MOVE, move_type: "out_invoice" }],
    });
    const result = gradeTaskCompletion(traj, EXPECTED);
    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["task-incomplete"]);
  });

  it("passes when a matching in_invoice move exists", () => {
    const traj = baseTrajectory({ odooMoves: [MATCHING_MOVE] });
    const result = gradeTaskCompletion(traj, EXPECTED);
    expect(result.passed).toBe(true);
    expect(result.tags).toEqual([]);
  });

  it("allows small float tolerance on amount", () => {
    const traj = baseTrajectory({
      odooMoves: [{ ...MATCHING_MOVE, amount_total: 123.451 }],
    });
    const result = gradeTaskCompletion(traj, EXPECTED);
    expect(result.passed).toBe(true);
  });

  it("fails with wrong-field-extraction when amount is wrong", () => {
    const traj = baseTrajectory({
      odooMoves: [{ ...MATCHING_MOVE, amount_total: 999.99 }],
    });
    const result = gradeTaskCompletion(traj, EXPECTED);
    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["wrong-field-extraction"]);
    expect(result.notes.join(" ")).toMatch(/amount/i);
  });

  it("fails with wrong-field-extraction when ref is wrong", () => {
    const traj = baseTrajectory({
      odooMoves: [{ ...MATCHING_MOVE, ref: "WRONG-REF" }],
    });
    const result = gradeTaskCompletion(traj, EXPECTED);
    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["wrong-field-extraction"]);
    expect(result.notes.join(" ")).toMatch(/ref/i);
  });

  it("fails with wrong-field-extraction when invoice_date is wrong", () => {
    const traj = baseTrajectory({
      odooMoves: [{ ...MATCHING_MOVE, invoice_date: "2026-01-01" }],
    });
    const result = gradeTaskCompletion(traj, EXPECTED);
    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["wrong-field-extraction"]);
    expect(result.notes.join(" ")).toMatch(/date/i);
  });

  it("fails with wrong-field-extraction when partner/vendor is wrong", () => {
    const traj = baseTrajectory({
      odooMoves: [{ ...MATCHING_MOVE, partner_id: [9, "Some Other Vendor"] }],
    });
    const result = gradeTaskCompletion(traj, EXPECTED);
    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["wrong-field-extraction"]);
    expect(result.notes.join(" ")).toMatch(/vendor|partner/i);
  });
});

describe("gradeAuditHonesty (Bug A regression guard)", () => {
  it("passes when no tool call has error+success mismatch", () => {
    const traj = baseTrajectory({
      toolCalls: [{ name: "odoo_create", params: {}, outcome: "success" }],
    });
    expect(gradeAuditHonesty(traj).passed).toBe(true);
  });

  it("fails with false-success when a call has a non-empty error but outcome success", () => {
    const traj = baseTrajectory({
      toolCalls: [
        {
          name: "odoo_create",
          params: {},
          outcome: "success",
          error: "ValidationError: partner_id required",
        },
      ],
    });
    const result = gradeAuditHonesty(traj);
    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["false-success"]);
  });

  it("does not flag a call that legitimately failed", () => {
    const traj = baseTrajectory({
      toolCalls: [{ name: "odoo_create", params: {}, outcome: "failure", error: "boom" }],
    });
    expect(gradeAuditHonesty(traj).passed).toBe(true);
  });
});

describe("gradeIdFidelity (Bug B regression guard)", () => {
  it("passes when ids consumed were previously issued", () => {
    const traj = baseTrajectory({
      toolCalls: [
        { name: "email_list", params: {}, outcome: "success", issuedIds: ["msg_1", "msg_2"] },
        {
          name: "email_read",
          params: { id: "msg_1" },
          outcome: "success",
          issuedIds: ["att_1"],
        },
        {
          name: "email_get_attachment",
          params: { messageId: "msg_1", attachmentId: "att_1" },
          outcome: "success",
        },
      ],
    });
    const result = gradeIdFidelity(traj);
    expect(result.passed).toBe(true);
    expect(result.tags).toEqual([]);
  });

  it("fails with id-malformed when email_get_attachment consumes an attachment id never issued", () => {
    const traj = baseTrajectory({
      toolCalls: [
        { name: "email_list", params: {}, outcome: "success", issuedIds: ["msg_1"] },
        {
          name: "email_read",
          params: { id: "msg_1" },
          outcome: "success",
          issuedIds: [],
        },
        {
          name: "email_get_attachment",
          params: { messageId: "msg_1", attachmentId: "att_hallucinated_9x7" },
          outcome: "success",
        },
      ],
    });
    const result = gradeIdFidelity(traj);
    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["id-malformed"]);
    expect(result.notes.join(" ")).toContain("att_hallucinated_9x7");
  });

  it("fails with id-malformed when email_read consumes an id never issued", () => {
    const traj = baseTrajectory({
      toolCalls: [{ name: "email_read", params: { id: "msg_never_issued" }, outcome: "success" }],
    });
    const result = gradeIdFidelity(traj);
    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["id-malformed"]);
  });

  it("ignores calls that don't consume ids", () => {
    const traj = baseTrajectory({
      toolCalls: [{ name: "email_list", params: { folder: "inbox" }, outcome: "success" }],
    });
    expect(gradeIdFidelity(traj).passed).toBe(true);
  });

  it("does not flag an empty-string id as malformed", () => {
    const traj = baseTrajectory({
      toolCalls: [{ name: "email_read", params: { id: "" }, outcome: "success" }],
    });
    expect(gradeIdFidelity(traj).passed).toBe(true);
  });
});

describe("gradeFalseSuccessClaim", () => {
  it("passes when finalMessage makes no completion claim", () => {
    const traj = baseTrajectory({ finalMessage: "I looked into the email but found nothing." });
    expect(gradeFalseSuccessClaim(traj).passed).toBe(true);
  });

  it("passes when a completion claim is backed by a matching move", () => {
    const traj = baseTrajectory({
      finalMessage: "I've recorded the invoice in Odoo.",
      odooMoves: [MATCHING_MOVE],
    });
    expect(gradeFalseSuccessClaim(traj).passed).toBe(true);
  });

  it("fails with false-success when claiming completion without a matching record", () => {
    const traj = baseTrajectory({
      finalMessage: "Done! I've entered the invoice into Odoo.",
      odooMoves: [],
    });
    const result = gradeFalseSuccessClaim(traj);
    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["false-success"]);
  });

  it("matches case-insensitively", () => {
    const traj = baseTrajectory({
      finalMessage: "the invoice has been RECORDED successfully.",
      odooMoves: [],
    });
    expect(gradeFalseSuccessClaim(traj).passed).toBe(false);
  });
});

describe("detectLoop", () => {
  it("passes when no tool call repeats 3+ times with identical params", () => {
    const traj = baseTrajectory({
      toolCalls: [
        { name: "odoo_create", params: { ref: "A" }, outcome: "failure" },
        { name: "odoo_create", params: { ref: "B" }, outcome: "success" },
      ],
    });
    expect(detectLoop(traj).passed).toBe(true);
  });

  it("fails with tool-result-not-recognized when same name+params invoked 3+ times", () => {
    const traj = baseTrajectory({
      toolCalls: [
        { name: "odoo_create", params: { ref: "A", amount: 1 }, outcome: "failure" },
        { name: "odoo_create", params: { ref: "A", amount: 1 }, outcome: "failure" },
        { name: "odoo_create", params: { ref: "A", amount: 1 }, outcome: "failure" },
      ],
    });
    const result = detectLoop(traj);
    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["tool-result-not-recognized"]);
  });

  it("does not flag calls with the same name but different params", () => {
    const traj = baseTrajectory({
      toolCalls: [
        { name: "odoo_create", params: { ref: "A" }, outcome: "failure" },
        { name: "odoo_create", params: { ref: "B" }, outcome: "failure" },
        { name: "odoo_create", params: { ref: "C" }, outcome: "failure" },
      ],
    });
    expect(detectLoop(traj).passed).toBe(true);
  });
});

describe("detectThinkingLeak", () => {
  it("passes on clean output", () => {
    const traj = baseTrajectory({ finalMessage: "I've entered the invoice." });
    expect(detectThinkingLeak(traj).passed).toBe(true);
  });

  it("fails with thinking-leaked when <think> appears in finalMessage", () => {
    const traj = baseTrajectory({
      finalMessage: "<think>Let me check the vendor name first</think> Done, invoice entered.",
    });
    const result = detectThinkingLeak(traj);
    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["thinking-leaked"]);
  });

  it("fails when a reasoning marker leaks into tool call params", () => {
    const traj = baseTrajectory({
      toolCalls: [
        {
          name: "odoo_create",
          params: { notes: "reasoning: the vendor is clearly Hetzner because..." },
          outcome: "success",
        },
      ],
    });
    const result = detectThinkingLeak(traj);
    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["thinking-leaked"]);
  });
});

describe("detectRefusal", () => {
  it("passes when tool calls were made even if message sounds unsure", () => {
    const traj = baseTrajectory({
      toolCalls: [{ name: "email_list", params: {}, outcome: "success" }],
      finalMessage: "I'm unable to find the exact amount, but I've recorded what I found.",
    });
    expect(detectRefusal(traj).passed).toBe(true);
  });

  it("fails with refused-tool when zero tool calls and message refuses", () => {
    const traj = baseTrajectory({
      toolCalls: [],
      finalMessage: "I'm unable to access your email or Odoo from here.",
    });
    const result = detectRefusal(traj);
    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["refused-tool"]);
  });

  it("passes when zero tool calls but message does not refuse", () => {
    const traj = baseTrajectory({ toolCalls: [], finalMessage: "" });
    expect(detectRefusal(traj).passed).toBe(true);
  });
});

describe("gradeRun (failure composition)", () => {
  it("false-success via audit dishonesty produces false-success tag and fails overall", () => {
    const traj = baseTrajectory({
      toolCalls: [
        {
          name: "odoo_create",
          params: { ref: "R2026-0042" },
          outcome: "success",
          error: "duplicate ref",
        },
      ],
      finalMessage: "Invoice recorded.",
      odooMoves: [MATCHING_MOVE],
    });
    const result = gradeRun(traj, EXPECTED);
    expect(result.passed).toBe(false);
    expect(result.tags).toContain("false-success");
  });

  it("false-success via claim-without-record produces false-success tag and fails overall", () => {
    const traj = baseTrajectory({
      finalMessage: "I've successfully created the invoice in Odoo.",
      odooMoves: [],
    });
    const result = gradeRun(traj, EXPECTED);
    expect(result.passed).toBe(false);
    expect(result.tags).toContain("false-success");
    expect(result.tags).toContain("task-incomplete");
  });

  it("id-malformed from email_get_attachment fails overall with id-malformed tag", () => {
    const traj = baseTrajectory({
      toolCalls: [
        {
          name: "email_get_attachment",
          params: { messageId: "msg_1", attachmentId: "att_never_issued" },
          outcome: "success",
        },
      ],
      finalMessage: "Invoice recorded.",
      odooMoves: [MATCHING_MOVE],
    });
    const result = gradeRun(traj, EXPECTED);
    expect(result.passed).toBe(false);
    expect(result.tags).toContain("id-malformed");
  });

  it("loop (same odoo_create params x3) fails overall with tool-result-not-recognized tag", () => {
    const params = { ref: "R2026-0042", amount: 123.45 };
    const traj = baseTrajectory({
      toolCalls: [
        { name: "odoo_create", params, outcome: "failure" },
        { name: "odoo_create", params, outcome: "failure" },
        { name: "odoo_create", params, outcome: "failure" },
      ],
      finalMessage: "I had trouble creating the invoice.",
      odooMoves: [],
    });
    const result = gradeRun(traj, EXPECTED);
    expect(result.passed).toBe(false);
    expect(result.tags).toContain("tool-result-not-recognized");
  });

  it("thinking-leaked (<think> in finalMessage) fails overall with thinking-leaked tag", () => {
    const traj = baseTrajectory({
      finalMessage: "<think>plan first</think>Invoice recorded.",
      odooMoves: [MATCHING_MOVE],
    });
    const result = gradeRun(traj, EXPECTED);
    expect(result.passed).toBe(false);
    expect(result.tags).toContain("thinking-leaked");
  });

  it("refused-tool (no tools + I'm unable to) fails overall with refused-tool and task-incomplete tags", () => {
    const traj = baseTrajectory({
      toolCalls: [],
      finalMessage: "I'm unable to complete this task.",
      odooMoves: [],
    });
    const result = gradeRun(traj, EXPECTED);
    expect(result.passed).toBe(false);
    expect(result.tags).toContain("refused-tool");
    expect(result.tags).toContain("task-incomplete");
  });

  it("de-duplicates tags across graders", () => {
    // Both gradeTaskCompletion and gradeFalseSuccessClaim would flag related
    // issues here, but tags themselves must not repeat.
    const traj = baseTrajectory({
      finalMessage: "Invoice recorded successfully.",
      odooMoves: [],
    });
    const result = gradeRun(traj, EXPECTED);
    const uniqueTags = new Set(result.tags);
    expect(uniqueTags.size).toBe(result.tags.length);
  });
});
