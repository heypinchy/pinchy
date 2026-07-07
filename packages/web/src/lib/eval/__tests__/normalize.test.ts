import { describe, expect, it } from "vitest";
import {
  ATT_PREFIX,
  handleFor,
  MSG_PREFIX,
} from "../../../../../plugins/pinchy-email/id-handle-store";
import { gradeRun } from "../graders";
import { buildTrajectory } from "../normalize";
import type { NormalizeInput } from "../normalize";
import type { ExpectedInvoice } from "../types";

const SEEDED_MESSAGE_ID =
  "AAMkAGI1AAAtNzZmYS00OTZkLWFmZWMtY2Y0MzE4YzViMjllAAAAAAEMAAA0Y2ZjNzM4Yy1jZjE5LTQ0NDQtOTk4Yy1hZmU3NmM4ZTQ3ZTAAKgAAAA==";
const SEEDED_ATTACHMENT_ID =
  "AAMkAGI1AAAtNzZmYS00OTZkLWFmZWMtY2Y0MzE4YzViMjllAAAAAAEMAAA0Y2ZjNzM4Yy1jZjE5LTQ0NDQtOTk4Yy1hZmU3NmM4ZTQ3ZTAAKgAAAAAAAAAAAA==";

const EXPECTED: ExpectedInvoice = {
  vendorName: "Hetzner Online GmbH",
  invoiceNumber: "R0012345678",
  invoiceDate: "2026-06-30",
  amountTotal: 47.6,
};

function baseInput(overrides: Partial<NormalizeInput> = {}): NormalizeInput {
  return {
    model: "ollama-cloud/kimi-k2.6",
    auditEntries: [],
    finalMessage: "",
    odooMoves: [],
    seededMessageId: SEEDED_MESSAGE_ID,
    seededAttachmentId: SEEDED_ATTACHMENT_ID,
    latencyMs: 1000,
    ...overrides,
  };
}

describe("buildTrajectory", () => {
  it("sorts audit entries by timestamp ascending into toolCalls", () => {
    const traj = buildTrajectory(
      baseInput({
        auditEntries: [
          {
            eventType: "tool.email_read",
            outcome: "success",
            detail: { toolName: "email_read", params: { id: "msg_abc" } },
            timestamp: "2026-07-07T10:00:02.000Z",
          },
          {
            eventType: "tool.email_list",
            outcome: "success",
            detail: { toolName: "email_list", params: {} },
            timestamp: "2026-07-07T10:00:01.000Z",
          },
        ],
      })
    );

    expect(traj.toolCalls.map((c) => c.name)).toEqual(["email_list", "email_read"]);
  });

  it("maps eventType/detail into ToolCall name/params/outcome/error", () => {
    const traj = buildTrajectory(
      baseInput({
        auditEntries: [
          {
            eventType: "tool.odoo_create",
            outcome: "failure",
            detail: { toolName: "odoo_create", params: { model: "account.move" }, error: "boom" },
            timestamp: "2026-07-07T10:00:03.000Z",
          },
        ],
      })
    );

    expect(traj.toolCalls).toEqual([
      {
        name: "odoo_create",
        params: { model: "account.move" },
        outcome: "failure",
        error: "boom",
        issuedIds: undefined,
      },
    ]);
  });

  it("falls back to eventType suffix for name and {} for params when detail is sparse", () => {
    const traj = buildTrajectory(
      baseInput({
        auditEntries: [
          {
            eventType: "tool.email_get_attachment",
            outcome: "success",
            detail: null,
            timestamp: "2026-07-07T10:00:04.000Z",
          },
        ],
      })
    );

    expect(traj.toolCalls[0]?.name).toBe("email_get_attachment");
    expect(traj.toolCalls[0]?.params).toEqual({});
  });

  it("ignores non tool.* audit entries", () => {
    const traj = buildTrajectory(
      baseInput({
        auditEntries: [
          {
            eventType: "agent.updated",
            outcome: "success",
            detail: null,
            timestamp: "2026-07-07T10:00:00.000Z",
          },
        ],
      })
    );

    expect(traj.toolCalls).toEqual([]);
  });

  it("computes issued handles via handleFor and attaches them to the earliest email_list/email_read calls", () => {
    const msgHandle = handleFor(SEEDED_MESSAGE_ID, MSG_PREFIX);
    const attHandle = handleFor(SEEDED_ATTACHMENT_ID, ATT_PREFIX);

    const traj = buildTrajectory(
      baseInput({
        auditEntries: [
          {
            eventType: "tool.email_list",
            outcome: "success",
            detail: { toolName: "email_list", params: {} },
            timestamp: "2026-07-07T10:00:01.000Z",
          },
          {
            eventType: "tool.email_read",
            outcome: "success",
            detail: { toolName: "email_read", params: { id: msgHandle } },
            timestamp: "2026-07-07T10:00:02.000Z",
          },
        ],
      })
    );

    const listCall = traj.toolCalls.find((c) => c.name === "email_list");
    const readCall = traj.toolCalls.find((c) => c.name === "email_read");
    expect(listCall?.issuedIds).toEqual([msgHandle]);
    expect(readCall?.issuedIds).toEqual([attHandle]);
  });

  it("only attaches issuedIds to the EARLIEST matching call, not later duplicates", () => {
    const msgHandle = handleFor(SEEDED_MESSAGE_ID, MSG_PREFIX);

    const traj = buildTrajectory(
      baseInput({
        auditEntries: [
          {
            eventType: "tool.email_list",
            outcome: "success",
            detail: { toolName: "email_list", params: {} },
            timestamp: "2026-07-07T10:00:01.000Z",
          },
          {
            eventType: "tool.email_list",
            outcome: "success",
            detail: { toolName: "email_list", params: {} },
            timestamp: "2026-07-07T10:00:02.000Z",
          },
        ],
      })
    );

    expect(traj.toolCalls[0]?.issuedIds).toEqual([msgHandle]);
    expect(traj.toolCalls[1]?.issuedIds).toBeUndefined();
  });

  it("passes through odooMoves, model, finalMessage, latencyMs, tokens", () => {
    const move = {
      id: 1,
      move_type: "in_invoice",
      partner_id: [7, "Hetzner Online GmbH"] as [number, string],
      ref: "R0012345678",
      invoice_date: "2026-06-30",
      amount_total: 47.6,
    };

    const traj = buildTrajectory(
      baseInput({
        finalMessage: "Done — I've entered the Hetzner invoice into Odoo.",
        odooMoves: [move],
        tokens: { prompt: 100, completion: 50 },
      })
    );

    expect(traj.model).toBe("ollama-cloud/kimi-k2.6");
    expect(traj.finalMessage).toBe("Done — I've entered the Hetzner invoice into Odoo.");
    expect(traj.odooMoves).toEqual([move]);
    expect(traj.latencyMs).toBe(1000);
    expect(traj.tokens).toEqual({ prompt: 100, completion: 50 });
  });

  describe("end-to-end against gradeRun", () => {
    it("a complete happy trajectory grades passed:true", () => {
      const msgHandle = handleFor(SEEDED_MESSAGE_ID, MSG_PREFIX);
      const attHandle = handleFor(SEEDED_ATTACHMENT_ID, ATT_PREFIX);

      const traj = buildTrajectory(
        baseInput({
          auditEntries: [
            {
              eventType: "tool.email_list",
              outcome: "success",
              detail: { toolName: "email_list", params: {} },
              timestamp: "2026-07-07T10:00:01.000Z",
            },
            {
              eventType: "tool.email_read",
              outcome: "success",
              detail: { toolName: "email_read", params: { id: msgHandle } },
              timestamp: "2026-07-07T10:00:02.000Z",
            },
            {
              eventType: "tool.email_get_attachment",
              outcome: "success",
              detail: {
                toolName: "email_get_attachment",
                params: { messageId: msgHandle, attachmentId: attHandle },
              },
              timestamp: "2026-07-07T10:00:03.000Z",
            },
            {
              eventType: "tool.odoo_create",
              outcome: "success",
              detail: {
                toolName: "odoo_create",
                params: { model: "account.move", ref: "R0012345678" },
              },
              timestamp: "2026-07-07T10:00:04.000Z",
            },
          ],
          finalMessage: "Done — I've entered the Hetzner invoice into Odoo.",
          odooMoves: [
            {
              id: 1,
              move_type: "in_invoice",
              partner_id: [7, "Hetzner Online GmbH"],
              ref: "R0012345678",
              invoice_date: "2026-06-30",
              amount_total: 47.6,
            },
          ],
        })
      );

      const result = gradeRun(traj, EXPECTED);
      expect(result.passed).toBe(true);
      expect(result.tags).toEqual([]);
    });

    it("a false-success trajectory (odoo empty + claims completion) grades failed with false-success", () => {
      const msgHandle = handleFor(SEEDED_MESSAGE_ID, MSG_PREFIX);

      const traj = buildTrajectory(
        baseInput({
          auditEntries: [
            {
              eventType: "tool.email_list",
              outcome: "success",
              detail: { toolName: "email_list", params: {} },
              timestamp: "2026-07-07T10:00:01.000Z",
            },
            {
              eventType: "tool.email_read",
              outcome: "success",
              detail: { toolName: "email_read", params: { id: msgHandle } },
              timestamp: "2026-07-07T10:00:02.000Z",
            },
          ],
          finalMessage: "Done — I've entered the invoice.",
          odooMoves: [],
        })
      );

      const result = gradeRun(traj, EXPECTED);
      expect(result.passed).toBe(false);
      expect(result.tags).toContain("false-success");
    });
  });
});
