// Real-DB integration tests for the Inbox Agent processed-email ledger.
// The ledger is the source of truth for "has this workflow already handled this
// email" — an atomic INSERT ... ON CONFLICT DO NOTHING claim (design D2/D3).
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import {
  agents,
  emailWorkflows,
  emailWorkflowConnections,
  emailConnectionCursors,
  processedEmails,
  integrationConnections,
} from "@/db/schema";
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

async function seedConnection(id: string) {
  const [row] = await db
    .insert(integrationConnections)
    .values({
      id,
      type: "imap",
      name: "Mailbox",
      credentials: "enc:placeholder",
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

    // The winner gets the new ledger row's id (the dispatcher uses it as the
    // notification's sourceId); a re-claim gets null.
    expect(await claimEmail(key)).toEqual(expect.any(String)); // first caller wins
    expect(await claimEmail(key)).toBeNull(); // re-claim rejected (idempotent)
  });

  it("lets a different workflow claim the same email independently", async () => {
    const agent = await seedAgent();
    const wfA = await seedWorkflow(agent.id);
    const wfB = await seedWorkflow(agent.id);
    const msg = { connectionId: "conn-1", providerMessageId: "msg-1" };

    expect(await claimEmail({ workflowId: wfA.id, ...msg })).toEqual(expect.any(String));
    // Per-rule scope (D3): the same email is claimable once per workflow.
    expect(await claimEmail({ workflowId: wfB.id, ...msg })).toEqual(expect.any(String));
  });

  it("is atomic under concurrent claims — exactly one winner", async () => {
    const agent = await seedAgent();
    const wf = await seedWorkflow(agent.id);
    const key = { workflowId: wf.id, connectionId: "conn-1", providerMessageId: "race-1" };

    // The whole point of the ON CONFLICT DO NOTHING claim (design §12) is that it
    // holds under a race, not just sequentially. drizzle/postgres-js gives each
    // query its own pooled connection, so these five run as genuinely concurrent
    // transactions. A naive SELECT-then-INSERT would let more than one win here.
    const results = await Promise.all([
      claimEmail(key),
      claimEmail(key),
      claimEmail(key),
      claimEmail(key),
      claimEmail(key),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
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
    expect(await claimEmail(key)).toBeNull();
  });

  it("throws when finalizing an email that was never claimed", async () => {
    const agent = await seedAgent();
    const wf = await seedWorkflow(agent.id);

    // finalize-before-claim is always a bug: surface it loudly rather than
    // silently updating zero rows and leaving the (nonexistent) row unmarked.
    await expect(
      finalizeEmail({
        workflowId: wf.id,
        connectionId: "conn-1",
        providerMessageId: "never-claimed",
        status: "done",
      })
    ).rejects.toThrow(/no processing ledger row/);
  });

  it("does not re-write a terminal row — a second finalize throws", async () => {
    const agent = await seedAgent();
    const wf = await seedWorkflow(agent.id);
    const key = { workflowId: wf.id, connectionId: "conn-1", providerMessageId: "msg-1" };

    await claimEmail(key);
    await finalizeEmail({ ...key, status: "done", outcome: { note: "first" } });

    // finalize only ever transitions processing → terminal. A duplicate finalize
    // (e.g. a buggy retry) must NOT silently overwrite the recorded outcome —
    // the WHERE clause no longer matches, so zero rows update and we throw.
    await expect(finalizeEmail({ ...key, status: "failed" })).rejects.toThrow(
      /no processing ledger row/
    );

    // The original terminal state is preserved untouched.
    const row = await getProcessed(key);
    expect(row.status).toBe("done");
    expect(row.outcome).toEqual({ note: "first" });
  });
});

describe("email ledger — status CHECK constraints", () => {
  // Flatten drizzle's wrapped error chain: the violated constraint name lands on
  // `.cause`, not the top-level message. Mirrors schema-hardening's helper.
  function violates(pattern: RegExp) {
    return (err: unknown) => {
      const e = err as {
        message?: unknown;
        cause?: { message?: unknown; constraint?: unknown };
        constraint?: unknown;
      };
      const text = [e?.message, e?.cause?.message, e?.cause?.constraint, e?.constraint]
        .filter((v): v is string => typeof v === "string")
        .join(" ");
      return pattern.test(text);
    };
  }

  it("rejects an out-of-domain processed_emails.status at the DB", async () => {
    const agent = await seedAgent();
    const wf = await seedWorkflow(agent.id);
    await expect(
      db.insert(processedEmails).values({
        workflowId: wf.id,
        connectionId: "conn-1",
        providerMessageId: "msg-1",
        status: "bogus" as never,
      })
    ).rejects.toSatisfy(violates(/processed_emails_status_check/));
  });

  it("rejects an out-of-domain email_workflows.status at the DB", async () => {
    const agent = await seedAgent();
    await expect(
      db.insert(emailWorkflows).values({
        agentId: agent.id,
        name: "Bad status",
        filter: {},
        action: "noop",
        status: "bogus" as never,
      })
    ).rejects.toSatisfy(violates(/email_workflows_status_check/));
  });
});

describe("email ledger — durability across connection deletion", () => {
  it("keeps the ledger row after its integration connection is deleted", async () => {
    const agent = await seedAgent();
    const wf = await seedWorkflow(agent.id);
    const conn = await seedConnection("conn-survives");
    const key = { workflowId: wf.id, connectionId: conn.id, providerMessageId: "msg-1" };

    await claimEmail(key);
    await finalizeEmail({ ...key, status: "done" });

    // processed_emails.connectionId is intentionally FK-less: the ledger is a
    // historical record of what was already handled. Deleting the connection
    // (user disconnects the mailbox) must NOT erase that trail — otherwise a
    // reconnect + resync would reprocess every past email. This test locks in
    // the no-FK decision against a future "helpful" FK addition.
    await db.delete(integrationConnections).where(eq(integrationConnections.id, conn.id));

    const row = await getProcessed(key);
    expect(row).toBeDefined();
    expect(row.status).toBe("done");
  });
});

describe("email schema — cascade & watermark", () => {
  it("cascades the workflow↔connection link when the workflow is deleted", async () => {
    const agent = await seedAgent();
    const wf = await seedWorkflow(agent.id);
    const conn = await seedConnection("conn-cascade-wf");
    await db
      .insert(emailWorkflowConnections)
      .values({ workflowId: wf.id, connectionId: conn.id, sinceTs: new Date() });

    await db.delete(emailWorkflows).where(eq(emailWorkflows.id, wf.id));

    const rows = await db
      .select()
      .from(emailWorkflowConnections)
      .where(eq(emailWorkflowConnections.workflowId, wf.id));
    expect(rows).toHaveLength(0);
  });

  it("cascades the workflow↔connection link when the connection is deleted", async () => {
    const agent = await seedAgent();
    const wf = await seedWorkflow(agent.id);
    const conn = await seedConnection("conn-cascade-conn");
    await db
      .insert(emailWorkflowConnections)
      .values({ workflowId: wf.id, connectionId: conn.id, sinceTs: new Date() });

    await db.delete(integrationConnections).where(eq(integrationConnections.id, conn.id));

    const rows = await db
      .select()
      .from(emailWorkflowConnections)
      .where(eq(emailWorkflowConnections.connectionId, conn.id));
    expect(rows).toHaveLength(0);
  });

  it("cascades the sync cursor when its connection is deleted", async () => {
    const conn = await seedConnection("conn-cursor");
    await db.insert(emailConnectionCursors).values({ connectionId: conn.id, cursor: "cursor-abc" });

    await db.delete(integrationConnections).where(eq(integrationConnections.id, conn.id));

    const rows = await db
      .select()
      .from(emailConnectionCursors)
      .where(eq(emailConnectionCursors.connectionId, conn.id));
    expect(rows).toHaveLength(0);
  });
});
