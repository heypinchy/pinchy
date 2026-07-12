// Real-DB integration tests for the Inbox Agent processed-email ledger.
// The ledger is the source of truth for "has this workflow already handled this
// email" — an atomic INSERT ... ON CONFLICT DO NOTHING claim (design D2/D3).
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { agents, emailWorkflows, processedEmails } from "@/db/schema";
import { claimEmail, finalizeEmail } from "@/lib/email-workflows/ledger";

async function getProcessed(key: {
  workflowId: string;
  connectionId: string;
  providerMessageId: string;
}) {
  const [row] = await db
    .select()
    .from(processedEmails)
    .where(
      and(
        eq(processedEmails.workflowId, key.workflowId),
        eq(processedEmails.connectionId, key.connectionId),
        eq(processedEmails.providerMessageId, key.providerMessageId)
      )
    );
  return row;
}

async function seedAgent() {
  const [row] = await db
    .insert(agents)
    .values({
      name: "Penny",
      model: "ollama-cloud/gemini-3-flash",
      greetingMessage: "Hi",
    })
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

describe("email ledger — claimEmail", () => {
  it("claims an email exactly once", async () => {
    const agent = await seedAgent();
    const wf = await seedWorkflow(agent.id);
    const key = { workflowId: wf.id, connectionId: "conn-1", providerMessageId: "msg-1" };

    expect(await claimEmail(key)).toBe(true); // first caller wins
    expect(await claimEmail(key)).toBe(false); // re-claim rejected (idempotent)
  });

  it("lets a different workflow claim the same email independently", async () => {
    const agent = await seedAgent();
    const wfA = await seedWorkflow(agent.id);
    const wfB = await seedWorkflow(agent.id);
    const msg = { connectionId: "conn-1", providerMessageId: "msg-1" };

    expect(await claimEmail({ workflowId: wfA.id, ...msg })).toBe(true);
    // Per-rule scope (D3): the same email is claimable once per workflow.
    expect(await claimEmail({ workflowId: wfB.id, ...msg })).toBe(true);
  });
});

describe("email ledger — finalizeEmail", () => {
  it("finalizes a claimed email with a terminal status and outcome", async () => {
    const agent = await seedAgent();
    const wf = await seedWorkflow(agent.id);
    const key = { workflowId: wf.id, connectionId: "conn-1", providerMessageId: "msg-1" };

    await claimEmail(key);
    await finalizeEmail({
      ...key,
      status: "done",
      outcome: { odooModel: "account.move", odooId: 42 },
      runId: "run-1",
    });

    const row = await getProcessed(key);
    expect(row.status).toBe("done");
    expect(row.outcome).toEqual({ odooModel: "account.move", odooId: 42 });
    expect(row.runId).toBe("run-1");
    expect(row.finalizedAt).not.toBeNull();
  });

  it("a resync/sweep re-discovering a done email does not re-claim it", async () => {
    const agent = await seedAgent();
    const wf = await seedWorkflow(agent.id);
    const key = { workflowId: wf.id, connectionId: "conn-1", providerMessageId: "msg-1" };

    await claimEmail(key);
    await finalizeEmail({ ...key, status: "done" });

    // Simulate the reconciliation sweep finding the same provider message again
    // after a cursor loss: the ledger — not the cursor — is the source of truth,
    // so the already-finalized email must NOT be re-processed.
    expect(await claimEmail(key)).toBe(false);
  });
});
