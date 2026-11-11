import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Granting a folder to an existing agent starts its first index (#1280) — the
// same run creating the agent starts, so a folder added on the Permissions tab
// is searchable without anyone finding "Reindex now". Which folders are new,
// and whether the slot is free, is decided by queueFirstIndex (tested against a
// real database); this file pins only what the route owes it: the call, the
// admin as its requester, and that a failure to queue never fails the save.

const { mockQueueFirstIndex } = vi.hoisted(() => ({
  mockQueueFirstIndex: vi.fn(),
}));
vi.mock("@/lib/knowledge/first-index", () => ({
  queueFirstIndex: mockQueueFirstIndex,
}));

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
import { updateAgent } from "@/lib/agents";
import { appendAuditLog } from "@/lib/audit";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { db } from "@/db";

const EXISTING = {
  id: "agent-1",
  name: "Handbook",
  model: "old",
  allowedTools: ["knowledge_search"],
  pluginConfig: { "pinchy-files": { allowed_paths: ["/data/hr"] } },
  isPersonal: false,
  ownerId: null,
};

function adminSession() {
  vi.mocked(auth.api.getSession).mockResolvedValueOnce({
    user: { id: "user-1", role: "admin" },
    expires: "",
  } as never);
}

function mockAgent(agent: Record<string, unknown>) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([agent]) }),
  } as never);
}

function patch(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/agents/agent-1", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const GRANT = {
  allowedTools: ["knowledge_search"],
  pluginConfig: { "pinchy-files": { allowed_paths: ["/data/hr", "/data/legal"] } },
};

describe("PATCH /api/agents/[agentId] — first index of a newly granted folder (#1280)", () => {
  let PATCH: typeof import("@/app/api/agents/[agentId]/route").PATCH;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockQueueFirstIndex.mockResolvedValue({ status: "queued", jobId: "job-1" });
    const mod = await import("@/app/api/agents/[agentId]/route");
    PATCH = mod.PATCH;
  });

  it("queues it as the admin who saved the grant, and audits what it queued", async () => {
    adminSession();
    mockAgent(EXISTING);
    vi.mocked(updateAgent).mockResolvedValueOnce({ ...EXISTING, ...GRANT } as never);

    const res = await PATCH(patch(GRANT), { params: Promise.resolve({ agentId: "agent-1" }) });

    expect(res.status).toBe(200);
    expect(mockQueueFirstIndex).toHaveBeenCalledWith(
      "agent-1",
      { actorType: "user", actorId: "user-1" },
      expect.any(Function)
    );
    const audit = mockQueueFirstIndex.mock.calls[0][2];
    const entry = { eventType: "knowledge.reindex", outcome: "success" };
    audit(entry);
    await flushAfter();
    expect(appendAuditLog).toHaveBeenCalledWith(entry);
  });

  it("does not look when nothing that grants a folder changed", async () => {
    adminSession();
    mockAgent(EXISTING);
    vi.mocked(updateAgent).mockResolvedValueOnce({ ...EXISTING, name: "Renamed" } as never);

    await PATCH(patch({ name: "Renamed" }), { params: Promise.resolve({ agentId: "agent-1" }) });

    expect(mockQueueFirstIndex).not.toHaveBeenCalled();
  });

  // The grant is committed before the push fails, so the index worker still
  // queues its first index on its next look — as kb-index-worker. The route
  // only leaves it to the worker rather than attributing it to this admin.
  it("leaves the run to the worker when the runtime push failed", async () => {
    adminSession();
    mockAgent(EXISTING);
    vi.mocked(updateAgent).mockResolvedValueOnce({ ...EXISTING, ...GRANT } as never);
    vi.mocked(regenerateOpenClawConfig).mockRejectedValueOnce(new Error("EACCES"));

    const res = await PATCH(patch(GRANT), { params: Promise.resolve({ agentId: "agent-1" }) });

    expect(res.status).toBe(500);
    expect(mockQueueFirstIndex).not.toHaveBeenCalled();
  });

  it("still saves when the run cannot be queued", async () => {
    adminSession();
    mockAgent(EXISTING);
    vi.mocked(updateAgent).mockResolvedValueOnce({ ...EXISTING, ...GRANT } as never);
    mockQueueFirstIndex.mockRejectedValueOnce(new Error("connection reset"));

    const res = await PATCH(patch(GRANT), { params: Promise.resolve({ agentId: "agent-1" }) });

    expect(res.status).toBe(200);
  });
});
