import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// When regenerateOpenClawConfig() throws, updateAgent() has ALREADY written the
// agents row — the DB update runs first and there is no transaction around the
// pair. The route had no try/catch, so the throw escaped into Next.js, which
// answers 500 with a framework body carrying no `error` field. The client then
// showed a flat "Failed to save some settings".
//
// That message is wrong in both directions, and the production incident (#1095)
// is what it costs. The real state was: model saved to the DB, runtime never
// told, no audit row, and the cause (EACCES on a root-owned TOOLS.md) visible
// only in `docker compose logs`. The user retried four times in three minutes.
//
// So the route must answer the two questions the flat message destroyed:
// WHAT persisted, and WHY the rest did not.

// `after()` defers the audit write past the response. Run it inline so the
// assertions can see it, matching the convention in the other route tests.
const pendingAfter: Promise<unknown>[] = [];
async function flushAfter(): Promise<void> {
  while (pendingAfter.length > 0) {
    await Promise.allSettled(pendingAfter.splice(0));
  }
}
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: vi.fn((fn: () => void | Promise<void>) => {
      try {
        const result = fn();
        if (result instanceof Promise) pendingAfter.push(result.catch(() => {}));
      } catch {
        // Swallowed — matches Next's after() error handling.
      }
    }),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
// Only appendAuditLog is faked. safeProviderError stays real — the assertions
// below are about the sanitising the route actually applies, and a stubbed
// version would let an unsanitised detail pass.
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, appendAuditLog: vi.fn().mockResolvedValue(undefined) };
});
vi.mock("@/lib/groups", () => ({
  getUserGroupIds: vi.fn().mockResolvedValue([]),
  getAgentGroupIds: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/auth", () => {
  const mockGetSession = vi.fn();
  return { getSession: mockGetSession, auth: { api: { getSession: mockGetSession } } };
});
vi.mock("@/lib/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agents")>();
  return { ...actual, updateAgent: vi.fn() };
});
vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/workspace", () => ({
  ensureWorkspace: vi.fn(),
  writeWorkspaceFile: vi.fn(),
  writeWorkspaceFileInternal: vi.fn(),
  writeIdentityFile: vi.fn(),
}));
vi.mock("@/lib/telegram-allow-store", () => ({
  recalculateTelegramAllowStores: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/enterprise", () => ({
  isEnterprise: vi.fn().mockResolvedValue(false),
  getLicenseState: vi.fn().mockResolvedValue("community"),
}));
vi.mock("@/lib/provider-models", () => ({
  fetchProviderModels: vi.fn().mockResolvedValue([
    {
      id: "ollama-cloud",
      name: "Ollama Cloud",
      models: [{ id: "ollama-cloud/deepseek-v4-pro", name: "deepseek-v4-pro" }],
    },
  ]),
}));
vi.mock("@/db", () => {
  const insert = vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
  const del = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  return {
    db: {
      insert,
      delete: del,
      // Group assignment runs inside a transaction; hand the callback a tx that
      // behaves like db so the route's writes resolve.
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ insert, delete: del })
      ),
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      })),
    },
  };
});
vi.mock("@/db/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/schema")>();
  return { ...actual };
});

import { auth } from "@/lib/auth";
import { updateAgent, AgentRuntimeUpdateError } from "@/lib/agents";
import { appendAuditLog } from "@/lib/audit";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { recalculateTelegramAllowStores } from "@/lib/telegram-allow-store";
import { db } from "@/db";

function mockAgent(agent: Record<string, unknown>) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([agent]) }),
  } as never);
}

function adminSession() {
  vi.mocked(auth.api.getSession).mockResolvedValueOnce({
    user: { id: "user-1", role: "admin" },
    expires: "",
  } as never);
}

function patchModel() {
  return new NextRequest("http://localhost/api/agents/agent-1", {
    method: "PATCH",
    body: JSON.stringify({ model: "ollama-cloud/deepseek-v4-pro" }),
    headers: { "Content-Type": "application/json" },
  });
}

/** The exact shape production failed with: EACCES on a root-owned TOOLS.md. */
function eaccesOnToolsFile(): Error {
  const err: NodeJS.ErrnoException = new Error(
    "EACCES: permission denied, open '/openclaw-config/workspaces/agent-1/TOOLS.md'"
  );
  err.code = "EACCES";
  err.errno = -13;
  return err;
}

const PERSISTED_ROW = {
  id: "agent-1",
  name: "Penny",
  model: "ollama-cloud/deepseek-v4-pro",
} as never;

/**
 * The row was written, the runtime push then failed — the production case.
 * updateAgent marks this with its own error type precisely so the route does
 * not have to guess which half broke.
 */
function runtimeFailure(): AgentRuntimeUpdateError {
  return new AgentRuntimeUpdateError(PERSISTED_ROW, eaccesOnToolsFile());
}

describe("PATCH /api/agents/[agentId] — config regeneration failure (#1095)", () => {
  let PATCH: typeof import("@/app/api/agents/[agentId]/route").PATCH;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/agents/[agentId]/route");
    PATCH = mod.PATCH;
  });

  it("answers with a JSON error instead of letting the throw escape to Next.js", async () => {
    adminSession();
    mockAgent({ id: "agent-1", name: "Penny", model: "old", isPersonal: false, ownerId: null });
    vi.mocked(updateAgent).mockRejectedValueOnce(runtimeFailure());

    const res = await PATCH(patchModel(), { params: Promise.resolve({ agentId: "agent-1" }) });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });

  it("names the underlying cause, so the operator does not need container logs", async () => {
    adminSession();
    mockAgent({ id: "agent-1", name: "Penny", model: "old", isPersonal: false, ownerId: null });
    vi.mocked(updateAgent).mockRejectedValueOnce(runtimeFailure());

    const res = await PATCH(patchModel(), { params: Promise.resolve({ agentId: "agent-1" }) });

    // The whole point: "Failed to save some settings" sent the user to us. The
    // response has to carry what `docker compose logs` carried.
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("EACCES") as unknown as string,
    });
  });

  it("says the settings were saved but the runtime was not updated", async () => {
    adminSession();
    mockAgent({ id: "agent-1", name: "Penny", model: "old", isPersonal: false, ownerId: null });
    vi.mocked(updateAgent).mockRejectedValueOnce(runtimeFailure());

    const res = await PATCH(patchModel(), { params: Promise.resolve({ agentId: "agent-1" }) });

    // updateAgent writes the row and THEN regenerates; a failure past that point
    // leaves the change persisted. Reporting a flat failure is a lie the user
    // acts on — they retry, and each retry looks like it changed nothing.
    const { error } = (await res.json()) as { error: string };
    expect(error.toLowerCase()).toContain("saved");
    expect(error.toLowerCase()).toMatch(/runtime|restart|not applied/);
  });

  it("does NOT claim the settings were saved when the write itself failed", async () => {
    // The other half of the same honesty problem. updateAgent throws from two
    // places — the row write and the runtime push — and "Settings were saved"
    // is only true for the second. Told it for a failed DB write, a user stops
    // retrying a change that never landed, which is the flat message's mistake
    // pointing the other way.
    adminSession();
    mockAgent({ id: "agent-1", name: "Penny", model: "old", isPersonal: false, ownerId: null });
    vi.mocked(updateAgent).mockRejectedValueOnce(new Error("connection terminated unexpectedly"));

    const res = await PATCH(patchModel(), { params: Promise.resolve({ agentId: "agent-1" }) });

    expect(res.status).toBe(500);
    const { error } = (await res.json()) as { error: string };
    expect(error.toLowerCase()).not.toContain("saved");
    expect(error).toContain("connection terminated unexpectedly");
  });

  it("writes an agent.updated audit row with outcome failure — the row DID change", async () => {
    // A regeneration failure is a state change: the model column already holds
    // the new value. AGENTS.md is explicit that every state-changing route
    // writes an audit entry, and `outcome: "failure"` exists for exactly this.
    // Returning 500 without one leaves the change with no trace at all.
    adminSession();
    mockAgent({ id: "agent-1", name: "Penny", model: "old", isPersonal: false, ownerId: null });
    vi.mocked(updateAgent).mockRejectedValueOnce(runtimeFailure());

    await PATCH(patchModel(), { params: Promise.resolve({ agentId: "agent-1" }) });
    await flushAfter();

    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "agent.updated",
        resource: "agent:agent-1",
        outcome: "failure",
        detail: expect.objectContaining({
          changes: { model: { from: "old", to: "ollama-cloud/deepseek-v4-pro" } },
        }) as unknown,
      })
    );
  });

  it("caps the cause, so a long one cannot evict the diff from the row", async () => {
    // appendAuditLog runs truncateDetail, and truncateDetail does NOT trim the
    // offending field — it replaces the whole detail object with a summary
    // blob. So an uncapped error string takes `changes` down with it, on the
    // one row whose entire value is recording what changed. safeAuditPath's
    // doc comment spells out this failure mode for caller-controlled fields.
    adminSession();
    mockAgent({ id: "agent-1", name: "Penny", model: "old", isPersonal: false, ownerId: null });
    const huge = new Error(`EACCES: ${"x".repeat(5000)}`);
    vi.mocked(updateAgent).mockRejectedValueOnce(new AgentRuntimeUpdateError(PERSISTED_ROW, huge));

    await PATCH(patchModel(), { params: Promise.resolve({ agentId: "agent-1" }) });
    await flushAfter();

    const entry = vi.mocked(appendAuditLog).mock.calls[0][0];
    const detail = entry.detail as { changes: unknown; runtimeUpdate: { error: string } };
    expect(Buffer.byteLength(detail.runtimeUpdate.error, "utf8")).toBeLessThanOrEqual(1024);
    expect(detail.changes).toEqual({ model: { from: "old", to: "ollama-cloud/deepseek-v4-pro" } });
  });

  it("keeps an email address out of the audit detail", async () => {
    // AGENTS.md: never write plaintext email addresses into audit `detail` —
    // the row is immutable and HMAC-chained, so it cannot be rewritten later.
    // Not hypothetical here: this code path exists because of TOOLS.md, the
    // file that carries an agent's MAILBOX context, so a failure message from
    // it is one of the likelier places for an address to appear.
    adminSession();
    mockAgent({ id: "agent-1", name: "Penny", model: "old", isPersonal: false, ownerId: null });
    vi.mocked(updateAgent).mockRejectedValueOnce(
      new AgentRuntimeUpdateError(
        PERSISTED_ROW,
        new Error("IMAP connection commercial@helmcraft.ai refused")
      )
    );

    await PATCH(patchModel(), { params: Promise.resolve({ agentId: "agent-1" }) });
    await flushAfter();

    const entry = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(JSON.stringify(entry.detail)).not.toContain("commercial@helmcraft.ai");
  });

  it("still gives the operator the unscrubbed cause in the response", async () => {
    // The two channels get different treatment on purpose. The audit row is
    // immutable, long-lived and subject to erasure requests; the response is
    // ephemeral and goes only to the authenticated user who just triggered it
    // — and stripping it there would undo the whole point of the change.
    adminSession();
    mockAgent({ id: "agent-1", name: "Penny", model: "old", isPersonal: false, ownerId: null });
    vi.mocked(updateAgent).mockRejectedValueOnce(
      new AgentRuntimeUpdateError(
        PERSISTED_ROW,
        new Error("IMAP connection commercial@helmcraft.ai refused")
      )
    );

    const res = await PATCH(patchModel(), { params: Promise.resolve({ agentId: "agent-1" }) });

    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("commercial@helmcraft.ai");
  });

  it("does not write an audit row when nothing was persisted", async () => {
    // The mirror of the test above: a failed row write changed nothing, so an
    // `agent.updated` row would assert a change that never happened.
    adminSession();
    mockAgent({ id: "agent-1", name: "Penny", model: "old", isPersonal: false, ownerId: null });
    vi.mocked(updateAgent).mockRejectedValueOnce(new Error("connection terminated unexpectedly"));

    await PATCH(patchModel(), { params: Promise.resolve({ agentId: "agent-1" }) });
    await flushAfter();

    expect(appendAuditLog).not.toHaveBeenCalled();
  });
});

// The handler pushes the runtime config from TWO places, and the tests above
// cover only the first. `updateAgent` pushes for the fields it owns; the tail
// of the handler pushes again for `allowedTools` / `pluginConfig`, because
// those change the generated openclaw.json without changing the agents row in a
// way updateAgent regenerates for.
//
// That second call went in unguarded, so it still escaped as a framework 500
// with no `error` field — on a PERMISSION change, which is the change #1095
// actually broke. And it sat AFTER the success audit registration: `after()`
// cannot be cancelled once queued, so the row was written anyway, claiming
// `outcome: "success"` for a request that answered 500.
describe("PATCH /api/agents/[agentId] — the permission-change config push", () => {
  let PATCH: typeof import("@/app/api/agents/[agentId]/route").PATCH;

  const EXISTING = {
    id: "agent-1",
    name: "Penny",
    model: "old",
    allowedTools: [],
    isPersonal: false,
    ownerId: null,
  };

  function patchTools() {
    return new NextRequest("http://localhost/api/agents/agent-1", {
      method: "PATCH",
      body: JSON.stringify({ allowedTools: ["email_read"] }),
      headers: { "Content-Type": "application/json" },
    });
  }

  async function patchToolsWithFailingPush() {
    adminSession();
    mockAgent(EXISTING);
    vi.mocked(updateAgent).mockResolvedValueOnce({
      ...EXISTING,
      allowedTools: ["email_read"],
    } as never);
    vi.mocked(regenerateOpenClawConfig).mockRejectedValueOnce(eaccesOnToolsFile());

    const res = await PATCH(patchTools(), { params: Promise.resolve({ agentId: "agent-1" }) });
    await flushAfter();
    return res;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/agents/[agentId]/route");
    PATCH = mod.PATCH;
  });

  it("answers the same readable error as the other push site", async () => {
    const res = await patchToolsWithFailingPush();

    expect(res.status).toBe(500);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/saved/i);
    expect(error).toContain("EACCES");
  });

  it("writes ONE audit row for the request, and it says failure", async () => {
    await patchToolsWithFailingPush();

    const rows = vi
      .mocked(appendAuditLog)
      .mock.calls.map(([entry]) => entry)
      .filter((entry) => entry.eventType === "agent.updated");

    // Two rows disagreeing about one request is worse than no row: whichever
    // an analyst reads first is as likely to be the wrong one.
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("failure");
    expect(rows[0].detail).toMatchObject({
      changes: { allowedTools: { to: ["email_read"] } },
      runtimeUpdate: { applied: false },
    });
  });

  it("still recalculates the Telegram allow-stores", async () => {
    // They mirror group and visibility rows that are already committed, and
    // they ran before the push until this early return existed. Skipping them
    // would leave the store enforcing an access rule the database dropped —
    // a drift introduced by the error path rather than by the error.
    adminSession();
    mockAgent(EXISTING);
    vi.mocked(updateAgent).mockResolvedValueOnce({
      ...EXISTING,
      allowedTools: ["email_read"],
    } as never);
    vi.mocked(regenerateOpenClawConfig).mockRejectedValueOnce(eaccesOnToolsFile());

    const res = await PATCH(
      new NextRequest("http://localhost/api/agents/agent-1", {
        method: "PATCH",
        body: JSON.stringify({ allowedTools: ["email_read"], groupIds: [] }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ agentId: "agent-1" }) }
    );

    expect(res.status).toBe(500);
    expect(recalculateTelegramAllowStores).toHaveBeenCalled();
  });

  it("still answers 200 and audits success when the push works", async () => {
    adminSession();
    mockAgent(EXISTING);
    vi.mocked(updateAgent).mockResolvedValueOnce({
      ...EXISTING,
      allowedTools: ["email_read"],
    } as never);

    const res = await PATCH(patchTools(), { params: Promise.resolve({ agentId: "agent-1" }) });
    await flushAfter();

    expect(res.status).toBe(200);
    const rows = vi
      .mocked(appendAuditLog)
      .mock.calls.map(([entry]) => entry)
      .filter((entry) => entry.eventType === "agent.updated");
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("success");
  });
});
