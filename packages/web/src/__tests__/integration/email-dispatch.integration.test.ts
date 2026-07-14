// Real-DB integration tests for the Inbox Agent dispatcher (Slice D). The
// dispatcher is the loop from design §6: for each new email × matching workflow,
// filter (deterministic) → claim (ledger) → isolated agent run → notify
// (activity feed) → finalize ledger (notify-before-finalize is load-bearing,
// see dispatch.ts). The run is injected (`runAgent`) so the lifecycle is
// testable without a real OpenClaw run; the last describe block wires the
// production adapter (`createOpenClawRunAgent`) against a mock gateway client.
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import {
  agents,
  users,
  emailWorkflows,
  notifications,
  notificationRecipients,
  processedEmails,
} from "@/db/schema";
import { dispatchEmails, RunDeferredError } from "@/lib/email-workflows/dispatch";
import type { RunAgent, WorkflowForDispatch } from "@/lib/email-workflows/dispatch";
import { createOpenClawRunAgent } from "@/lib/email-workflows/run-adapter";
import type { DispatchableEmail } from "@/lib/email-workflows/types";
import { inboxSessionKey } from "@/lib/session-key";

let userCounter = 0;
async function seedUser() {
  const [row] = await db
    .insert(users)
    .values({ email: `dispatch-${userCounter++}@test.local`, name: "Owner" })
    .returning();
  return row;
}

async function seedAgent() {
  const [row] = await db
    .insert(agents)
    .values({ name: "Penny", model: "ollama-cloud/gemini-3-flash", greetingMessage: "Hi" })
    .returning();
  return row;
}

async function seedWorkflow(agentId: string) {
  const [row] = await db
    .insert(emailWorkflows)
    .values({
      agentId,
      name: "File invoices",
      filter: { hasAttachment: true, attachmentType: "application/pdf" },
      action: "Draft a supplier bill in Odoo from the attached invoice.",
    })
    .returning();
  return row;
}

async function workflowForDispatch(
  overrides: Partial<WorkflowForDispatch> = {}
): Promise<WorkflowForDispatch> {
  const agent = await seedAgent();
  const user = await seedUser();
  const wf = await seedWorkflow(agent.id);
  return {
    id: wf.id,
    agentId: agent.id,
    connectionId: "conn-1",
    name: wf.name,
    filter: wf.filter,
    action: wf.action,
    recipientUserIds: [user.id],
    ...overrides,
  };
}

function email(overrides: Partial<DispatchableEmail> = {}): DispatchableEmail {
  return {
    providerMessageId: "msg-1",
    from: "vendor@supplier.com",
    to: ["ap@acme.com"],
    subject: "Invoice 4711",
    folder: "INBOX",
    attachments: [{ contentType: "application/pdf", filename: "invoice.pdf" }],
    receivedAt: new Date("2026-07-14T09:00:00Z"),
    ...overrides,
  };
}

const doneRun: RunAgent = async () => ({
  status: "done",
  outcome: { odooModel: "account.move", odooId: 7 },
  runId: "run-x",
  title: "1 invoice filed",
  content: "Drafted a supplier bill in Odoo.",
});

async function ledgerRow(workflowId: string, providerMessageId: string) {
  const [row] = await db
    .select()
    .from(processedEmails)
    .where(
      and(
        eq(processedEmails.workflowId, workflowId),
        eq(processedEmails.providerMessageId, providerMessageId)
      )
    );
  return row;
}

describe("dispatchEmails — fan-out lifecycle", () => {
  it("claims, runs, finalizes and notifies for a matching email", async () => {
    const workflow = await workflowForDispatch();
    const seen: { email: DispatchableEmail; ledgerId: string }[] = [];
    const runAgent: RunAgent = async (ctx) => {
      seen.push({ email: ctx.email, ledgerId: ctx.ledgerId });
      return doneRun(ctx);
    };

    const summary = await dispatchEmails({ workflow, emails: [email()], runAgent });

    // Ran exactly once, on the matching email.
    expect(seen).toHaveLength(1);
    expect(seen[0].email.providerMessageId).toBe("msg-1");
    expect(summary).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });

    // Ledger finalized with the run's terminal status + outcome.
    const row = await ledgerRow(workflow.id, "msg-1");
    // The run received the claim's ledger row id — the adapter keys the
    // isolated OpenClaw session by it, so this correlation must be exact.
    expect(seen[0].ledgerId).toBe(row.id);
    expect(row.status).toBe("done");
    expect(row.outcome).toEqual({ odooModel: "account.move", odooId: 7 });
    expect(row.runId).toBe("run-x");
    expect(row.finalizedAt).not.toBeNull();

    // Notification fanned out to the recipient, provenance points at the ledger row.
    const [note] = await db.select().from(notifications).where(eq(notifications.sourceId, row.id));
    expect(note.agentId).toBe(workflow.agentId);
    expect(note.sourceType).toBe("inbox");
    expect(note.status).toBe("success");
    expect(note.title).toBe("1 invoice filed");

    const recips = await db
      .select()
      .from(notificationRecipients)
      .where(eq(notificationRecipients.notificationId, note.id));
    expect(recips.map((r) => r.userId)).toEqual(workflow.recipientUserIds);
  });

  it("finalizes no_action and still notifies when the run reports nothing to do", async () => {
    const workflow = await workflowForDispatch();
    const noActionRun: RunAgent = async () => ({
      status: "no_action",
      title: "Nothing to file",
      content: "No matching invoices in this batch.",
    });

    const summary = await dispatchEmails({ workflow, emails: [email()], runAgent: noActionRun });

    expect(summary).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });

    // no_action is a terminal, successful outcome: the ledger records it (so a
    // resync never re-runs it) and the feed still gets a "checked, nothing to do"
    // entry — the run owns the title/content, so it is never empty noise.
    const row = await ledgerRow(workflow.id, "msg-1");
    expect(row.status).toBe("no_action");
    expect(row.finalizedAt).not.toBeNull();

    const [note] = await db.select().from(notifications).where(eq(notifications.sourceId, row.id));
    expect(note.status).toBe("success");
    expect(note.title).toBe("Nothing to file");
  });

  it("skips a non-matching email without claiming or running it", async () => {
    const workflow = await workflowForDispatch();
    let ran = 0;
    const runAgent: RunAgent = async (ctx) => {
      ran++;
      return doneRun(ctx);
    };

    // No PDF attachment → fails the workflow filter.
    const summary = await dispatchEmails({
      workflow,
      emails: [email({ attachments: [] })],
      runAgent,
    });

    expect(ran).toBe(0);
    expect(summary).toMatchObject({ claimed: 0, skippedFilter: 1, succeeded: 0 });
    expect(await ledgerRow(workflow.id, "msg-1")).toBeUndefined();
  });

  it("skips an already-claimed email (idempotent re-dispatch)", async () => {
    const workflow = await workflowForDispatch();
    let ran = 0;
    const runAgent: RunAgent = async (ctx) => {
      ran++;
      return doneRun(ctx);
    };

    // First dispatch processes it.
    await dispatchEmails({ workflow, emails: [email()], runAgent });
    // A resync re-discovers the same email; the ledger claim rejects it.
    const summary = await dispatchEmails({ workflow, emails: [email()], runAgent });

    expect(ran).toBe(1); // not run again
    expect(summary).toMatchObject({ claimed: 0, skippedAlreadyClaimed: 1 });

    const notes = await db
      .select()
      .from(notifications)
      .where(eq(notifications.agentId, workflow.agentId));
    expect(notes).toHaveLength(1); // no duplicate notification
  });

  it("refuses a workflow with no recipients before claiming anything", async () => {
    const workflow = await workflowForDispatch({ recipientUserIds: [] });

    await expect(
      dispatchEmails({ workflow, emails: [email()], runAgent: doneRun })
    ).rejects.toThrow(/recipient/i);

    // Fail-fast: nothing was claimed.
    expect(await ledgerRow(workflow.id, "msg-1")).toBeUndefined();
  });
});

describe("dispatchEmails — run failure", () => {
  it("finalizes as failed and notifies when the run throws", async () => {
    const workflow = await workflowForDispatch();
    const runAgent: RunAgent = async () => {
      throw new Error("Odoo unreachable: ECONNREFUSED");
    };

    const summary = await dispatchEmails({ workflow, emails: [email()], runAgent });

    expect(summary).toMatchObject({ claimed: 1, succeeded: 0, failed: 1 });

    // Ledger is finalized failed — never left stuck in `processing` (§8).
    const row = await ledgerRow(workflow.id, "msg-1");
    expect(row.status).toBe("failed");
    expect(row.finalizedAt).not.toBeNull();

    // A failure notification reaches the recipient, carrying the error.
    const [note] = await db.select().from(notifications).where(eq(notifications.sourceId, row.id));
    expect(note.status).toBe("failure");
    expect(note.sourceType).toBe("inbox");
    expect(note.errorMessage).toBe("Odoo unreachable: ECONNREFUSED");

    const recips = await db
      .select()
      .from(notificationRecipients)
      .where(eq(notificationRecipients.notificationId, note.id));
    expect(recips.map((r) => r.userId)).toEqual(workflow.recipientUserIds);
  });

  it("isolates a failed run — the rest of the batch still processes", async () => {
    const workflow = await workflowForDispatch();
    const runAgent: RunAgent = async (ctx) => {
      if (ctx.email.providerMessageId === "bad") throw new Error("boom");
      return doneRun(ctx);
    };

    const summary = await dispatchEmails({
      workflow,
      emails: [email({ providerMessageId: "bad" }), email({ providerMessageId: "good" })],
      runAgent,
    });

    expect(summary).toMatchObject({ claimed: 2, succeeded: 1, failed: 1 });
    expect((await ledgerRow(workflow.id, "bad")).status).toBe("failed");
    expect((await ledgerRow(workflow.id, "good")).status).toBe("done");
  });
});

describe("dispatchEmails — deferred run", () => {
  it("leaves the row processing (not failed) when the run signals RunDeferredError", async () => {
    const workflow = await workflowForDispatch();
    // A run that never started because the agent wasn't in the runtime yet —
    // a purely transient infra gap. It must be retryable by the reconciliation
    // sweep, not a terminal `failed` that the sweep can never re-discover.
    const runAgent: RunAgent = async () => {
      throw new RunDeferredError("agent not in the OpenClaw runtime yet");
    };

    const summary = await dispatchEmails({ workflow, emails: [email()], runAgent });

    expect(summary).toMatchObject({ claimed: 1, succeeded: 0, failed: 0, deferred: 1 });

    // Recoverable, exactly like a notify/finalize failure: the row stays
    // `processing` and is never finalized.
    const row = await ledgerRow(workflow.id, "msg-1");
    expect(row.status).toBe("processing");
    expect(row.finalizedAt).toBeNull();

    // A deferral is silent — no failure notification reaches the recipient,
    // because the email hasn't actually failed; the sweep will retry it.
    const notes = await db.select().from(notifications).where(eq(notifications.sourceId, row.id));
    expect(notes).toHaveLength(0);
  });

  it("isolates a deferred run — the rest of the batch still processes", async () => {
    const workflow = await workflowForDispatch();
    const runAgent: RunAgent = async (ctx) => {
      if (ctx.email.providerMessageId === "wait") {
        throw new RunDeferredError("not ready");
      }
      return doneRun(ctx);
    };

    const summary = await dispatchEmails({
      workflow,
      emails: [email({ providerMessageId: "wait" }), email({ providerMessageId: "go" })],
      runAgent,
    });

    expect(summary).toMatchObject({ claimed: 2, succeeded: 1, failed: 0, deferred: 1 });
    expect((await ledgerRow(workflow.id, "wait")).status).toBe("processing");
    expect((await ledgerRow(workflow.id, "go")).status).toBe("done");
  });
});

describe("dispatchEmails — delivery failure", () => {
  it("keeps a claimed email recoverable (processing) and does not abort the batch when notify fails", async () => {
    // A recipient id that is not a real user makes notify() fail on the FK when
    // it fans out — a realistic transient/misconfig delivery failure. The guard
    // above only rejects an *empty* recipient list, so a single ghost id gets
    // past it and reaches the insert.
    const workflow = await workflowForDispatch({ recipientUserIds: ["ghost-user-does-not-exist"] });

    // Two matching emails: if the first email's delivery failure aborted the
    // loop, the second would never be claimed. It must not.
    const summary = await dispatchEmails({
      workflow,
      emails: [email({ providerMessageId: "a" }), email({ providerMessageId: "b" })],
      runAgent: doneRun,
    });

    // Both emails were attempted; neither counts as succeeded, both deferred.
    expect(summary).toMatchObject({ claimed: 2, succeeded: 0, failed: 0, deferred: 2 });

    // Crucial: notify runs BEFORE finalize, so a notify failure leaves the row
    // in `processing` — recoverable by the reconciliation sweep — rather than a
    // `done` row with no notification, which no sweep could ever find again.
    expect((await ledgerRow(workflow.id, "a")).status).toBe("processing");
    expect((await ledgerRow(workflow.id, "b")).status).toBe("processing");

    // notify's transaction rolled back, so no orphan notification leaked.
    const notes = await db
      .select()
      .from(notifications)
      .where(eq(notifications.agentId, workflow.agentId));
    expect(notes).toHaveLength(0);
  });
});

describe("dispatchEmails × createOpenClawRunAgent — production adapter end-to-end", () => {
  it("streams a real-shaped OpenClaw run into a finalized ledger row and a feed notification", async () => {
    const workflow = await workflowForDispatch();
    const chatCalls: { message: string; options: Record<string, unknown> }[] = [];
    const client = {
      chat: (message: string, options: Record<string, unknown>) => {
        chatCalls.push({ message, options });
        return (async function* () {
          yield { type: "agent_start" as const, text: "", runId: "run-real" };
          yield {
            type: "text" as const,
            text:
              'Filed it.\n\n```json\n{"status":"done","title":"Invoice 4711 filed",' +
              '"content":"Drafted supplier bill.","outcome":{"odooModel":"account.move","odooId":9}}\n```',
            runId: "run-real",
          };
          yield { type: "done" as const, text: "", runId: "run-real" };
        })();
      },
      chatAbort: async () => undefined,
    };
    const runAgent = createOpenClawRunAgent({
      client: client as never,
      loadAgentModel: async () => "ollama-cloud/gemini-3-flash",
      waitForAgentReady: async () => true,
    });

    const summary = await dispatchEmails({ workflow, emails: [email()], runAgent });

    expect(summary).toMatchObject({ claimed: 1, succeeded: 1, failed: 0, deferred: 0 });

    // The ledger row carries the run's report verbatim, and the run was
    // addressed at the isolated inbox session keyed by exactly this row.
    const row = await ledgerRow(workflow.id, "msg-1");
    expect(row.status).toBe("done");
    expect(row.outcome).toEqual({ odooModel: "account.move", odooId: 9 });
    expect(row.runId).toBe("run-real");
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0].options.sessionKey).toBe(inboxSessionKey(workflow.agentId, row.id));

    // The feed entry is the agent's own headline, not a synthesized one.
    const [note] = await db.select().from(notifications).where(eq(notifications.sourceId, row.id));
    expect(note.title).toBe("Invoice 4711 filed");
    expect(note.status).toBe("success");
  });
});
