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

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock("@/lib/audit", () => ({ appendAuditLog: vi.fn().mockResolvedValue(undefined) }));
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
vi.mock("@/db", () => ({
  db: {
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    })),
  },
}));
vi.mock("@/db/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/schema")>();
  return { ...actual };
});

import { auth } from "@/lib/auth";
import { updateAgent } from "@/lib/agents";
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
    vi.mocked(updateAgent).mockRejectedValueOnce(eaccesOnToolsFile());

    const res = await PATCH(patchModel(), { params: Promise.resolve({ agentId: "agent-1" }) });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });

  it("names the underlying cause, so the operator does not need container logs", async () => {
    adminSession();
    mockAgent({ id: "agent-1", name: "Penny", model: "old", isPersonal: false, ownerId: null });
    vi.mocked(updateAgent).mockRejectedValueOnce(eaccesOnToolsFile());

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
    vi.mocked(updateAgent).mockRejectedValueOnce(eaccesOnToolsFile());

    const res = await PATCH(patchModel(), { params: Promise.resolve({ agentId: "agent-1" }) });

    // updateAgent writes the row and THEN regenerates; a failure past that point
    // leaves the change persisted. Reporting a flat failure is a lie the user
    // acts on — they retry, and each retry looks like it changed nothing.
    const { error } = (await res.json()) as { error: string };
    expect(error.toLowerCase()).toContain("saved");
    expect(error.toLowerCase()).toMatch(/runtime|restart|not applied/);
  });
});
