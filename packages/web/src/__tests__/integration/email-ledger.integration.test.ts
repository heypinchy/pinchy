// Real-DB integration tests for the Inbox Agent processed-email ledger.
// The ledger is the source of truth for "has this workflow already handled this
// email" — an atomic INSERT ... ON CONFLICT DO NOTHING claim (design D2/D3).
import { describe, it, expect } from "vitest";

import { db } from "@/db";
import { agents, emailWorkflows } from "@/db/schema";
import { claimEmail } from "@/lib/email-workflows/ledger";

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
