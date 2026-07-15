// Real-DB integration tests for the Inbox Agent workflow loader (Brick A). The
// loader is the missing link between the DB and the already-complete
// `dispatchEmails`: it reads every *enabled* workflow, fans it out to one unit
// of work per connection, and resolves the notification recipients per the
// scope model (design §7) — personal agent → its owner, shared agent → the
// creator. Its output (`WorkflowForDispatch` + the connection's `sinceTs`) is
// exactly what the mail lister (Brick C) and the dispatcher consume.
//
// The suite runs against the ephemeral integration Postgres; there is no global
// truncate between tests, and the loader reads ALL enabled workflows, so every
// assertion is scoped to the workflow ids the test itself seeded.
import { describe, it, expect } from "vitest";

import { db } from "@/db";
import {
  agents,
  users,
  emailWorkflows,
  emailWorkflowConnections,
  integrationConnections,
} from "@/db/schema";
import type { EmailWorkflowStatus } from "@/db/enums";
import { loadDispatchableWorkflows } from "@/lib/email-workflows/loader";

let userCounter = 0;
async function seedUser() {
  const [row] = await db
    .insert(users)
    .values({ email: `loader-${userCounter++}@test.local`, name: "Owner" })
    .returning();
  return row;
}

async function seedAgent(opts: { isPersonal?: boolean; ownerId?: string | null } = {}) {
  const [row] = await db
    .insert(agents)
    .values({
      name: "Penny",
      model: "ollama-cloud/gemini-3-flash",
      greetingMessage: "Hi",
      isPersonal: opts.isPersonal ?? false,
      ownerId: opts.ownerId ?? null,
    })
    .returning();
  return row;
}

let connCounter = 0;
async function seedConnection() {
  const id = `loader-conn-${connCounter++}`;
  const [row] = await db
    .insert(integrationConnections)
    .values({ id, type: "imap", name: "Mailbox", credentials: "enc:placeholder" })
    .returning();
  return row;
}

async function seedWorkflow(opts: {
  agentId: string;
  enabled: boolean;
  createdBy?: string | null;
  status?: EmailWorkflowStatus;
}) {
  const [row] = await db
    .insert(emailWorkflows)
    .values({
      agentId: opts.agentId,
      name: "File invoices",
      filter: { hasAttachment: true, attachmentType: "application/pdf" },
      action: "Draft a supplier bill in Odoo from the attached invoice.",
      enabled: opts.enabled,
      createdBy: opts.createdBy ?? null,
      ...(opts.status ? { status: opts.status } : {}),
    })
    .returning();
  return row;
}

async function linkConnection(workflowId: string, connectionId: string, sinceTs: Date) {
  await db.insert(emailWorkflowConnections).values({ workflowId, connectionId, sinceTs });
}

const onlyWorkflow = (rows: Awaited<ReturnType<typeof loadDispatchableWorkflows>>, id: string) =>
  rows.filter((r) => r.workflow.id === id);

describe("email workflow loader — loadDispatchableWorkflows", () => {
  it("loads an enabled personal-agent workflow with the owner as the recipient", async () => {
    const owner = await seedUser();
    // A different creator than the owner pins the scope branch: a personal
    // workflow notifies the OWNER, never the creator (design §7).
    const creator = await seedUser();
    const agent = await seedAgent({ isPersonal: true, ownerId: owner.id });
    const wf = await seedWorkflow({ agentId: agent.id, enabled: true, createdBy: creator.id });
    const conn = await seedConnection();
    const since = new Date("2026-07-01T00:00:00.000Z");
    await linkConnection(wf.id, conn.id, since);

    const mine = onlyWorkflow(await loadDispatchableWorkflows(), wf.id);

    expect(mine).toEqual([
      {
        workflow: {
          id: wf.id,
          agentId: agent.id,
          connectionId: conn.id,
          name: "File invoices",
          filter: { hasAttachment: true, attachmentType: "application/pdf" },
          action: "Draft a supplier bill in Odoo from the attached invoice.",
          recipientUserIds: [owner.id],
        },
        sinceTs: since,
        // The sweep's listing window (design §5 default). Carried per workflow
        // so the reconciliation sweep can bound its re-list without re-reading
        // the row.
        sweepWindowDays: 14,
      },
    ]);
  });

  it("skips disabled workflows — only enabled ones are dispatched", async () => {
    const owner = await seedUser();
    const agent = await seedAgent({ isPersonal: true, ownerId: owner.id });
    const wf = await seedWorkflow({ agentId: agent.id, enabled: false, createdBy: owner.id });
    const conn = await seedConnection();
    await linkConnection(wf.id, conn.id, new Date());

    const mine = onlyWorkflow(await loadDispatchableWorkflows(), wf.id);

    expect(mine).toHaveLength(0);
  });

  it("resolves a shared-agent workflow's recipient to the creator, not an owner", async () => {
    const creator = await seedUser();
    // A shared agent has no personal owner; the recipient must come from the
    // workflow's creator (design §7), never from a stray ownerId.
    const strayOwner = await seedUser();
    const agent = await seedAgent({ isPersonal: false, ownerId: strayOwner.id });
    const wf = await seedWorkflow({ agentId: agent.id, enabled: true, createdBy: creator.id });
    const conn = await seedConnection();
    await linkConnection(wf.id, conn.id, new Date());

    const mine = onlyWorkflow(await loadDispatchableWorkflows(), wf.id);

    expect(mine).toHaveLength(1);
    expect(mine[0].workflow.recipientUserIds).toEqual([creator.id]);
  });

  it("fans out one unit of work per connection, each with its own sinceTs", async () => {
    const owner = await seedUser();
    const agent = await seedAgent({ isPersonal: true, ownerId: owner.id });
    const wf = await seedWorkflow({ agentId: agent.id, enabled: true, createdBy: owner.id });
    const connA = await seedConnection();
    const connB = await seedConnection();
    const sinceA = new Date("2026-06-01T00:00:00.000Z");
    const sinceB = new Date("2026-06-15T00:00:00.000Z");
    await linkConnection(wf.id, connA.id, sinceA);
    await linkConnection(wf.id, connB.id, sinceB);

    const mine = onlyWorkflow(await loadDispatchableWorkflows(), wf.id);

    expect(mine).toHaveLength(2);
    expect(new Map(mine.map((r) => [r.workflow.connectionId, r.sinceTs]))).toEqual(
      new Map([
        [connA.id, sinceA],
        [connB.id, sinceB],
      ])
    );
  });

  it("drops a workflow with no resolvable recipient — it would be undeliverable", async () => {
    // Shared agent, no creator recorded: dispatchEmails would reject an empty
    // recipient set, so the loader must not emit it at all.
    const agent = await seedAgent({ isPersonal: false, ownerId: null });
    const wf = await seedWorkflow({ agentId: agent.id, enabled: true, createdBy: null });
    const conn = await seedConnection();
    await linkConnection(wf.id, conn.id, new Date());

    const mine = onlyWorkflow(await loadDispatchableWorkflows(), wf.id);

    expect(mine).toHaveLength(0);
  });

  it("drops a personal-agent workflow whose agent has no owner — no fallback to the creator", async () => {
    // Symmetric to the shared/no-creator drop: a PERSONAL workflow resolves to
    // the agent owner and must NOT silently fall back to createdBy when the
    // owner is missing. A present creator here would be wrongly picked up by a
    // "recipient = owner ?? createdBy" mutation — so seed one to pin the branch.
    const creator = await seedUser();
    const agent = await seedAgent({ isPersonal: true, ownerId: null });
    const wf = await seedWorkflow({ agentId: agent.id, enabled: true, createdBy: creator.id });
    const conn = await seedConnection();
    await linkConnection(wf.id, conn.id, new Date());

    const mine = onlyWorkflow(await loadDispatchableWorkflows(), wf.id);

    expect(mine).toHaveLength(0);
  });

  it("dispatches an enabled workflow even when its status is 'error' — status is a health signal, not a dispatch gate", async () => {
    // `enabled` is the sole dispatch gate; `status` (pending|active|error) is an
    // observability field the dispatcher WRITES, never a gate it reads. Gating
    // on status would let one bad run wedge an enabled workflow off forever
    // (nothing resets it to active), breaking the at-least-once resilience the
    // ledger + sweep are built on. Pin that an errored-but-enabled workflow is
    // still loaded.
    const owner = await seedUser();
    const agent = await seedAgent({ isPersonal: true, ownerId: owner.id });
    const wf = await seedWorkflow({
      agentId: agent.id,
      enabled: true,
      createdBy: owner.id,
      status: "error",
    });
    const conn = await seedConnection();
    await linkConnection(wf.id, conn.id, new Date());

    const mine = onlyWorkflow(await loadDispatchableWorkflows(), wf.id);

    expect(mine).toHaveLength(1);
  });
});
