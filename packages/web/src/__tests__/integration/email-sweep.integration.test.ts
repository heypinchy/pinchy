// Real-DB integration tests for the Inbox Agent reconciliation sweep (Brick D) —
// the orchestrator that finally wires the finished bricks into one runnable pass:
// loader (A) → mail lister (C) → dispatcher (§6 filter/claim/run/notify/finalize).
//
// The sweep is the *correctness* path of design §4: it re-lists the last N days
// straight from each connection and dispatches whatever the ledger has not seen,
// so a lost/expired cursor can never lose an email. (The cheap cursor-driven poll
// is the event-trigger's job and needs OpenClaw 2026.7.1 — a later brick. The
// lister only speaks `sinceDays`, never a cursor, for exactly that reason.)
//
// The mailbox port and the agent run are injected, mirroring how `dispatchEmails`
// injects `RunAgent`: the production port is built from decrypted connection
// credentials and is out of this brick's scope.
//
// The suite runs against the ephemeral integration Postgres with no truncate
// between tests, and the sweep deliberately loads EVERY enabled workflow — so
// each test scopes its assertions to the rows it seeded itself, and its fake port
// hands back an empty mailbox for any connection it does not own.
import { describe, it, expect, vi } from "vitest";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import {
  agents,
  auditLog,
  users,
  emailWorkflows,
  emailWorkflowConnections,
  integrationConnections,
  processedEmails,
} from "@/db/schema";
import { claimEmail, finalizeEmail } from "@/lib/email-workflows/ledger";
import { runReconciliationSweep, SWEEP_LIST_LIMIT } from "@/lib/email-workflows/sweep";
import type { EmailPort, EmailReadResult } from "@/lib/email-workflows/lister";
import type { RunAgent } from "@/lib/email-workflows/dispatch";

let userCounter = 0;
async function seedUser() {
  const [row] = await db
    .insert(users)
    .values({ email: `sweep-${userCounter++}@test.local`, name: "Owner" })
    .returning();
  return row;
}

async function seedAgent(ownerId: string) {
  const [row] = await db
    .insert(agents)
    .values({
      name: "Penny",
      model: "ollama-cloud/gemini-3-flash",
      greetingMessage: "Hi",
      isPersonal: true,
      ownerId,
    })
    .returning();
  return row;
}

let connCounter = 0;
async function seedConnection() {
  const id = `sweep-conn-${connCounter++}`;
  const [row] = await db
    .insert(integrationConnections)
    .values({ id, type: "imap", name: "Mailbox", credentials: "enc:placeholder" })
    .returning();
  return row;
}

/**
 * One enabled personal-agent workflow on one fresh connection — the shape the
 * loader emits and the sweep consumes. `sinceTs` defaults to the epoch so the
 * watermark imposes no constraint unless a test opts in.
 */
async function seedDispatchableWorkflow(
  opts: { sinceTs?: Date; sweepWindowDays?: number; folder?: string } = {}
) {
  const owner = await seedUser();
  const agent = await seedAgent(owner.id);
  const [wf] = await db
    .insert(emailWorkflows)
    .values({
      agentId: agent.id,
      name: "File invoices",
      filter: {
        hasAttachment: true,
        attachmentType: "application/pdf",
        ...(opts.folder ? { folder: opts.folder } : {}),
      },
      action: "Draft a supplier bill in Odoo from the attached invoice.",
      enabled: true,
      createdBy: owner.id,
      ...(opts.sweepWindowDays ? { sweepWindowDays: opts.sweepWindowDays } : {}),
    })
    .returning();
  const conn = await seedConnection();
  await db.insert(emailWorkflowConnections).values({
    workflowId: wf.id,
    connectionId: conn.id,
    sinceTs: opts.sinceTs ?? new Date(0),
  });
  return { owner, agent, workflow: wf, connection: conn };
}

function message(overrides: Partial<EmailReadResult> = {}): EmailReadResult {
  return {
    id: "msg-1",
    from: "Vendor <vendor@supplier.com>",
    to: "ap@acme.com",
    cc: "",
    subject: "Invoice 4711",
    date: "2026-07-14T09:00:00.000Z",
    folder: "INBOX",
    attachments: [{ mimeType: "application/pdf", filename: "invoice.pdf" }],
    ...overrides,
  };
}

/**
 * A fake mailbox for exactly one connection. Every other connection (workflows
 * other tests seeded, which the global sweep also picks up) gets an empty
 * mailbox, so tests never dispatch each other's mail.
 */
function portFor(connectionId: string, messages: EmailReadResult[]) {
  const searchCalls: { sinceDays?: number; folder?: string; limit?: number }[] = [];
  const createPort = async (id: string): Promise<EmailPort> => ({
    search: async (opts) => {
      if (id !== connectionId) return [];
      searchCalls.push(opts);
      return messages.map((m) => ({ id: m.id }));
    },
    read: async (msgId) => messages.find((m) => m.id === msgId)!,
  });
  return { createPort, searchCalls };
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

describe("reconciliation sweep — loader → lister → dispatcher", () => {
  it("lists a connection's mail and dispatches a matching email into a finalized ledger row", async () => {
    const { workflow, connection } = await seedDispatchableWorkflow();
    const { createPort } = portFor(connection.id, [message()]);
    const ran: string[] = [];
    const runAgent: RunAgent = async (ctx) => {
      ran.push(ctx.email.providerMessageId);
      return doneRun(ctx);
    };

    await runReconciliationSweep({ createPort, runAgent });

    // The email travelled the whole chain: listed from the port, normalized by
    // the lister, past the filter, claimed, run, finalized.
    expect(ran).toEqual(["msg-1"]);
    const row = await ledgerRow(workflow.id, "msg-1");
    expect(row.status).toBe("done");
    expect(row.connectionId).toBe(connection.id);
    expect(row.outcome).toEqual({ odooModel: "account.move", odooId: 7 });
  });
});

describe("reconciliation sweep — sinceTs watermark", () => {
  it("never processes mail older than the workflow's sinceTs, even inside the sweep window", async () => {
    // The failure mode from design §8, "New workflow on old mailbox": the sweep
    // re-lists the last N days wholesale, so a workflow attached to a mailbox
    // today would retroactively act on two weeks of history — a flood of drafts
    // nobody asked for. `sinceTs` is the per-(workflow × connection) watermark
    // that bounds it, and NOTHING downstream enforces it: the lister only speaks
    // `sinceDays`, and neither `matchesFilter` nor `dispatchEmails` looks at
    // `receivedAt`. The sweep owns this gate.
    const { workflow, connection } = await seedDispatchableWorkflow({
      sinceTs: new Date("2026-07-10T00:00:00.000Z"),
    });
    const { createPort } = portFor(connection.id, [
      message({ id: "old", date: "2026-07-09T23:59:59.000Z" }),
      message({ id: "new", date: "2026-07-10T00:00:01.000Z" }),
    ]);
    const ran: string[] = [];
    const runAgent: RunAgent = async (ctx) => {
      ran.push(ctx.email.providerMessageId);
      return doneRun(ctx);
    };

    await runReconciliationSweep({ createPort, runAgent });

    expect(ran).toEqual(["new"]);
    // Below the watermark is not "skipped for now" — it must never be claimed,
    // or the ledger would record an email the workflow was never meant to see.
    expect(await ledgerRow(workflow.id, "old")).toBeUndefined();
    expect((await ledgerRow(workflow.id, "new")).status).toBe("done");
  });
});

describe("reconciliation sweep — listing window", () => {
  it("bounds the re-list by the workflow's own sweepWindowDays", async () => {
    // `sweepWindowDays` is the workflow's configured N (design §5, default 14).
    // It has to reach the provider query itself: the window is what keeps the
    // sweep's N+1 hydration bounded, and design §8 accepts "email older than N"
    // as a documented limitation only because N is honestly the *listing* bound.
    // Hardcoding a default here would silently ignore the column.
    const { connection } = await seedDispatchableWorkflow({ sweepWindowDays: 3 });
    const { createPort, searchCalls } = portFor(connection.id, [message()]);

    await runReconciliationSweep({ createPort, runAgent: doneRun });

    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0].sinceDays).toBe(3);
  });

  it("bounds how much mail one pass hydrates", async () => {
    // The lister hydrates EVERY candidate with a sequential read() — an N+1 whose
    // N is whatever the mailbox happens to hold in the window. `sweepWindowDays`
    // bounds the window in time, not in volume: a busy mailbox can hold thousands
    // of messages in 14 days, and the sweep would read them all, every cadence,
    // before the filter drops almost all of them.
    const { connection } = await seedDispatchableWorkflow();
    const { createPort, searchCalls } = portFor(connection.id, [message()]);

    await runReconciliationSweep({ createPort, runAgent: doneRun });

    expect(searchCalls[0].limit).toBe(SWEEP_LIST_LIMIT);
  });

  it("warns loudly when a pass fills its listing limit instead of truncating in silence", async () => {
    // The limit is a safety valve, and it has a real cost: `search` cannot filter
    // by the ledger, so the mail beyond the limit is not merely "deferred to the
    // next pass" — if the provider keeps returning the same saturated page, the
    // overflow is never dispatched at all. That risk is acceptable only while it
    // is VISIBLE, so saturation has to say so. Silent truncation in the component
    // whose entire job is "never lose an email" is the worst possible failure.
    const { connection } = await seedDispatchableWorkflow();
    const saturated = Array.from({ length: SWEEP_LIST_LIMIT }, (_, i) =>
      message({ id: `bulk-${i}` })
    );
    const { createPort } = portFor(connection.id, saturated);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let warned: string[] = [];
    try {
      await runReconciliationSweep({ createPort, runAgent: doneRun });
      // Read the calls BEFORE restoring: mockRestore() also clears mock.calls.
      warned = warn.mock.calls.map((call) => String(call[0]));
    } finally {
      warn.mockRestore();
    }

    expect(
      warned.some((msg) => msg.includes("listing limit") && msg.includes(connection.id)),
      `a saturated listing must name the connection that overflowed; warnings seen: ${JSON.stringify(warned)}`
    ).toBe(true);
  });

  it("still warns when a saturated page also holds a poison message", async () => {
    // Saturation is a property of what `search` RETURNS, not of what survives
    // hydration. The lister drops a message it cannot hydrate (bad date, a read
    // that 404s), so a saturated window with one poison mail hands back
    // LIMIT-1 usable emails. If the warning gated on the hydrated count it would
    // fall silent on exactly the pass that is BOTH truncated AND lossy — the
    // worst case, hidden by a single outlier. The signal must come from the
    // candidate count.
    const { connection } = await seedDispatchableWorkflow();
    const saturated = Array.from({ length: SWEEP_LIST_LIMIT }, (_, i) =>
      message({ id: `bulk-${i}` })
    );
    // Poison exactly one: an unparseable date makes the lister's normalize throw,
    // so it is isolated and dropped — LIMIT candidates, LIMIT-1 hydrated.
    saturated[0] = message({ id: "bulk-poison", date: "not-a-date" });
    const { createPort } = portFor(connection.id, saturated);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let warned: string[] = [];
    try {
      await runReconciliationSweep({ createPort, runAgent: doneRun });
      warned = warn.mock.calls.map((call) => String(call[0]));
    } finally {
      warn.mockRestore();
    }

    expect(
      warned.some((msg) => msg.includes("listing limit") && msg.includes(connection.id)),
      `a saturated listing must warn even when one message failed to hydrate; warnings seen: ${JSON.stringify(warned)}`
    ).toBe(true);
  });

  it("narrows the provider query to the filter's folder", async () => {
    // The filter re-checks the folder anyway, so this is purely about not
    // hydrating (read()) mail the filter is guaranteed to drop.
    const { connection } = await seedDispatchableWorkflow({ folder: "Invoices" });
    const { createPort, searchCalls } = portFor(connection.id, [message()]);

    await runReconciliationSweep({ createPort, runAgent: doneRun });

    expect(searchCalls[0].folder).toBe("Invoices");
  });
});

describe("reconciliation sweep — stuck claims", () => {
  const GRACE_MS = 10 * 60_000;

  /** Age a claim past the grace period, as if its run died `ms` ago. */
  async function backdateClaim(ledgerId: string, ms: number) {
    await db
      .update(processedEmails)
      .set({ claimedAt: new Date(Date.now() - ms) })
      .where(eq(processedEmails.id, ledgerId));
  }

  it("resets a stuck claim and re-processes the email within the same sweep", async () => {
    // A run that crashed (or deferred) after claiming leaves a `processing` row
    // forever: the ledger's unique claim key blocks any re-claim, so the email is
    // never retried — a permanent, silent gap. The sweep closes it by
    // delete-and-reclaim (#735) BEFORE it lists, so the freed email is re-listed
    // and re-dispatched in this same pass rather than one cadence later.
    const { workflow, connection } = await seedDispatchableWorkflow();
    const stuckId = await claimEmail({
      workflowId: workflow.id,
      connectionId: connection.id,
      providerMessageId: "msg-1",
    });
    await backdateClaim(stuckId!, GRACE_MS + 60_000);

    const { createPort } = portFor(connection.id, [message()]);
    const ran: string[] = [];
    const runAgent: RunAgent = async (ctx) => {
      ran.push(ctx.email.providerMessageId);
      return doneRun(ctx);
    };

    await runReconciliationSweep({ createPort, runAgent, graceMs: GRACE_MS });

    expect(ran).toEqual(["msg-1"]);
    const row = await ledgerRow(workflow.id, "msg-1");
    expect(row.status).toBe("done");
    // Delete-and-reclaim, not resurrect: the stuck row is gone and this is a
    // genuinely fresh claim — the identity `finalizeEmail` is pinned to (#735).
    expect(row.id).not.toBe(stuckId);
  });

  it("leaves a still-in-grace claim alone — a slow run is not a stuck run", async () => {
    // The mirror image, and the reason `graceMs` must exceed the run timeout: a
    // legitimately in-flight run must never be reset out from under itself. If
    // the sweep reset on age alone, every long run would be duplicated.
    const { workflow, connection } = await seedDispatchableWorkflow();
    const inFlightId = await claimEmail({
      workflowId: workflow.id,
      connectionId: connection.id,
      providerMessageId: "msg-1",
    });

    const { createPort } = portFor(connection.id, [message()]);
    const ran: string[] = [];
    const runAgent: RunAgent = async (ctx) => {
      ran.push(ctx.email.providerMessageId);
      return doneRun(ctx);
    };

    await runReconciliationSweep({ createPort, runAgent, graceMs: GRACE_MS });

    // Re-listed, but the surviving claim rejects the re-claim: no second run.
    expect(ran).toEqual([]);
    const row = await ledgerRow(workflow.id, "msg-1");
    expect(row.id).toBe(inFlightId);
    expect(row.status).toBe("processing");
  });

  it("never touches a terminal row, however old", async () => {
    // Only `processing` is stuck-able. Resetting an old `done` row would delete a
    // recorded outcome and re-run an email that was already handled.
    const { workflow, connection } = await seedDispatchableWorkflow();
    const ledgerId = await claimEmail({
      workflowId: workflow.id,
      connectionId: connection.id,
      providerMessageId: "msg-1",
    });
    await finalizeEmail({ id: ledgerId!, status: "done", outcome: { note: "already filed" } });
    await backdateClaim(ledgerId!, GRACE_MS * 100);

    const { createPort } = portFor(connection.id, [message()]);
    const ran: string[] = [];
    const runAgent: RunAgent = async (ctx) => {
      ran.push(ctx.email.providerMessageId);
      return doneRun(ctx);
    };

    await runReconciliationSweep({ createPort, runAgent, graceMs: GRACE_MS });

    expect(ran).toEqual([]);
    const row = await ledgerRow(workflow.id, "msg-1");
    expect(row.id).toBe(ledgerId);
    expect(row.outcome).toEqual({ note: "already filed" });
  });
});

async function workflowStatus(workflowId: string) {
  const [row] = await db
    .select({ status: emailWorkflows.status })
    .from(emailWorkflows)
    .where(eq(emailWorkflows.id, workflowId));
  return row.status;
}

describe("reconciliation sweep — workflow health status", () => {
  it("marks a workflow active once a pass completes", async () => {
    // `status` is the health signal the loader deliberately does NOT gate on —
    // it is written here and read by the Automations UI. A workflow is seeded
    // `pending`; the first clean pass is what proves it actually works.
    const { workflow, connection } = await seedDispatchableWorkflow();
    expect(await workflowStatus(workflow.id)).toBe("pending");
    const { createPort } = portFor(connection.id, [message()]);

    await runReconciliationSweep({ createPort, runAgent: doneRun });

    expect(await workflowStatus(workflow.id)).toBe("active");
  });

  it("marks a workflow error when its mailbox is unreachable, and recovers it on the next clean pass", async () => {
    // A broken connection (revoked token, wrong host) is the workflow-level
    // failure the user must see in the UI — it is invisible in the ledger,
    // because nothing was ever listed, let alone claimed.
    const { workflow, connection } = await seedDispatchableWorkflow();
    const failingPort = async (): Promise<EmailPort> => ({
      search: async () => {
        throw new Error("IMAP auth failed");
      },
      read: async () => {
        throw new Error("IMAP auth failed");
      },
    });

    await runReconciliationSweep({ createPort: failingPort, runAgent: doneRun });
    expect(await workflowStatus(workflow.id)).toBe("error");

    // Recovery must be automatic: `error` is a health signal, not a latch. If it
    // stuck, a workflow would need manual intervention after any blip — and the
    // loader (by design) will not gate on it, so it would silently keep running
    // while permanently displaying `error`.
    const { createPort } = portFor(connection.id, [message()]);
    await runReconciliationSweep({ createPort, runAgent: doneRun });

    expect(await workflowStatus(workflow.id)).toBe("active");
  });

  it("reports error when only ONE of a workflow's mailboxes is broken", async () => {
    // A workflow fans out to one unit of work per connection (D9), but `status`
    // is a single per-workflow column. If each unit wrote it directly, a
    // half-broken workflow's status would depend on which connection the loader
    // happened to return last — green on a coin flip, hiding a mailbox that is
    // silently processing nothing. Any broken connection must surface.
    // The broken connection is attached FIRST and the healthy one second, so the
    // healthy unit is the last to run. A naive "write the status inside the loop"
    // would end on `active` and bury the breakage — this ordering is what makes
    // the test load-bearing rather than accidentally green.
    const { workflow, connection: broken } = await seedDispatchableWorkflow();
    const good = await seedConnection();
    await db
      .insert(emailWorkflowConnections)
      .values({ workflowId: workflow.id, connectionId: good.id, sinceTs: new Date(0) });

    const { createPort: goodPort } = portFor(good.id, [message()]);
    const createPort = async (id: string): Promise<EmailPort> => {
      if (id === broken.id) throw new Error("connection credentials missing");
      return goodPort(id);
    };

    await runReconciliationSweep({ createPort, runAgent: doneRun });

    expect(await workflowStatus(workflow.id)).toBe("error");
    // The healthy mailbox still delivered — degraded, not dead.
    expect((await ledgerRow(workflow.id, "msg-1")).status).toBe("done");
  });

  it("isolates a broken workflow — the rest of the sweep still runs", async () => {
    // One unreachable mailbox must never stall every other workflow's mail.
    const broken = await seedDispatchableWorkflow();
    const healthy = await seedDispatchableWorkflow();
    const { createPort: healthyPort } = portFor(healthy.connection.id, [message()]);
    const createPort = async (id: string): Promise<EmailPort> => {
      if (id === broken.connection.id) throw new Error("connection credentials missing");
      return healthyPort(id);
    };

    await runReconciliationSweep({ createPort, runAgent: doneRun });

    expect(await workflowStatus(broken.workflow.id)).toBe("error");
    expect(await workflowStatus(healthy.workflow.id)).toBe("active");
    expect((await ledgerRow(healthy.workflow.id, "msg-1")).status).toBe("done");
  });
});

describe("reconciliation sweep — audit", () => {
  const GRACE_MS = 10 * 60_000;

  async function claimResetRows(workflowId: string) {
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "inbox.claim_reset"));
    return rows.filter(
      (r) => (r.detail as { workflow?: { id?: string } })?.workflow?.id === workflowId
    );
  }

  it("writes one audit row per reset claim, correlated by a shared sweepId", async () => {
    // Delete-and-reclaim destroys a ledger row — the one place the sweep loses
    // state. That must be attributable: an analyst has to be able to answer "why
    // was this email processed twice?" from the trail alone. `sweepId` is what
    // turns N scattered rows back into one drill-down query for a single run.
    const { workflow, connection } = await seedDispatchableWorkflow();
    for (const id of ["msg-1", "msg-2"]) {
      const stuck = await claimEmail({
        workflowId: workflow.id,
        connectionId: connection.id,
        providerMessageId: id,
      });
      await db
        .update(processedEmails)
        .set({ claimedAt: new Date(Date.now() - GRACE_MS - 60_000) })
        .where(eq(processedEmails.id, stuck!));
    }

    const { createPort } = portFor(connection.id, [
      message({ id: "msg-1" }),
      message({ id: "msg-2" }),
    ]);
    await runReconciliationSweep({ createPort, runAgent: doneRun, graceMs: GRACE_MS });

    const rows = await claimResetRows(workflow.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.outcome === "success")).toBe(true);
    expect(rows.every((r) => r.actorType === "system")).toBe(true);

    // One sweep ⟹ one correlation id across every row it emitted.
    const sweepIds = new Set(rows.map((r) => (r.detail as { sweepId: string }).sweepId));
    expect(sweepIds.size).toBe(1);

    // The workflow name is snapshotted beside the id: the row must stay readable
    // after the workflow is renamed or deleted.
    expect(rows.map((r) => r.detail)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workflow: { id: workflow.id, name: "File invoices" },
          connectionId: connection.id,
          providerMessageId: "msg-1",
        }),
        expect.objectContaining({ providerMessageId: "msg-2" }),
      ])
    );
  });

  it("writes no reset audit rows when nothing was stuck", async () => {
    // The trail must stay signal: a routine no-op sweep is not an event.
    const { workflow, connection } = await seedDispatchableWorkflow();
    const { createPort } = portFor(connection.id, [message()]);

    await runReconciliationSweep({ createPort, runAgent: doneRun, graceMs: GRACE_MS });

    expect(await claimResetRows(workflow.id)).toHaveLength(0);
  });
});
