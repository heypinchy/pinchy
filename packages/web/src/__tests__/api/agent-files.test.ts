import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => {
  const mockGetSession = vi.fn().mockResolvedValue({ user: { id: "1", email: "admin@test.com" } });
  return {
    getSession: mockGetSession,
    auth: {
      api: {
        getSession: mockGetSession,
      },
    },
  };
});

vi.mock("@/lib/workspace", () => ({
  readWorkspaceFile: vi.fn().mockReturnValue("# Soul content"),
  writeWorkspaceFile: vi.fn(),
}));

const { mockAppendAuditLog } = vi.hoisted(() => ({ mockAppendAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ appendAuditLog: mockAppendAuditLog }));

const { mockRecordAuditFailure } = vi.hoisted(() => ({ mockRecordAuditFailure: vi.fn() }));
vi.mock("@/lib/audit-deferred", () => ({ recordAuditFailure: mockRecordAuditFailure }));

const { mockRequireAgentWriteAccess } = vi.hoisted(() => ({
  // Returns null when write is allowed; returns a NextResponse(403) when denied.
  mockRequireAgentWriteAccess: vi.fn(),
}));
vi.mock("@/lib/agent-access", () => ({
  getAgentWithAccess: vi.fn(),
  requireAgentWriteAccess: mockRequireAgentWriteAccess,
}));

import { auth } from "@/lib/auth";
import { readWorkspaceFile, writeWorkspaceFile } from "@/lib/workspace";
import { getAgentWithAccess } from "@/lib/agent-access";
import { GET, PUT } from "@/app/api/agents/[agentId]/files/[filename]/route";

const defaultAgent = {
  id: "agent-1",
  name: "Smithers",
  model: "anthropic/claude-sonnet-4-20250514",
  templateId: null,
  pluginConfig: null,
  allowedTools: [],
  skills: [],
  ownerId: null,
  isPersonal: false,
  visibility: "restricted" as const,
  greetingMessage: "Hi, I'm Smithers.",
  tagline: null,
  starterPrompts: [],
  avatarSeed: null,
  personalityPresetId: null,
  createdAt: new Date(),
  deletedAt: null,
};

function makeGetRequest(agentId: string, filename: string) {
  return new NextRequest(`http://localhost/api/agents/${agentId}/files/${filename}`, {
    method: "GET",
  });
}

function makePutRequest(agentId: string, filename: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/agents/${agentId}/files/${filename}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeParams(agentId: string, filename: string) {
  return { params: Promise.resolve({ agentId, filename }) };
}

describe("GET /api/agents/[agentId]/files/[filename]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default mocks
    vi.mocked(auth.api.getSession).mockResolvedValue({
      user: { id: "1", email: "admin@test.com" },
    } as any);
    vi.mocked(getAgentWithAccess).mockResolvedValue(defaultAgent);
    vi.mocked(readWorkspaceFile).mockReturnValue("# Soul content");
  });

  it("should return file content for an allowed file", async () => {
    const request = makeGetRequest("agent-1", "SOUL.md");
    const response = await GET(request, makeParams("agent-1", "SOUL.md"));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.content).toBe("# Soul content");
    expect(readWorkspaceFile).toHaveBeenCalledWith("agent-1", "SOUL.md");
  });

  it("should return 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const request = makeGetRequest("agent-1", "SOUL.md");
    const response = await GET(request, makeParams("agent-1", "SOUL.md"));

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe("Unauthorized");
  });

  it("forwards the getAgentWithAccess denial verbatim, whatever its status", async () => {
    // Synthetic 403 sentinel — the helper really denies with 404 (see its
    // docblock). A status it never emits keeps this distinct from the route's
    // own 404 paths, so the test proves forwarding rather than coincidence.
    vi.mocked(getAgentWithAccess).mockResolvedValueOnce(
      NextResponse.json({ error: "Forbidden" }, { status: 403 })
    );

    const request = makeGetRequest("agent-1", "SOUL.md");
    const response = await GET(request, makeParams("agent-1", "SOUL.md"));

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe("Forbidden");
  });

  it("should return 404 when agent does not exist", async () => {
    vi.mocked(getAgentWithAccess).mockResolvedValueOnce(
      NextResponse.json({ error: "Agent not found" }, { status: 404 })
    );

    const request = makeGetRequest("nonexistent", "SOUL.md");
    const response = await GET(request, makeParams("nonexistent", "SOUL.md"));

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe("Agent not found");
  });

  it("should return 400 when filename is not allowed", async () => {
    vi.mocked(readWorkspaceFile).mockImplementationOnce(() => {
      throw new Error("File not allowed: SECRET.md");
    });

    const request = makeGetRequest("agent-1", "SECRET.md");
    const response = await GET(request, makeParams("agent-1", "SECRET.md"));

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("File not allowed: SECRET.md");
  });

  it("should return 400 for USER.md (no longer in ALLOWED_FILES)", async () => {
    vi.mocked(readWorkspaceFile).mockImplementationOnce(() => {
      throw new Error("File not allowed: USER.md");
    });

    const request = makeGetRequest("agent-1", "USER.md");
    const response = await GET(request, makeParams("agent-1", "USER.md"));

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("File not allowed: USER.md");
  });

  it("should read AGENTS.md file", async () => {
    vi.mocked(readWorkspaceFile).mockReturnValueOnce("# Agent instructions");

    const request = makeGetRequest("agent-1", "AGENTS.md");
    const response = await GET(request, makeParams("agent-1", "AGENTS.md"));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.content).toBe("# Agent instructions");
    expect(readWorkspaceFile).toHaveBeenCalledWith("agent-1", "AGENTS.md");
  });

  it("should return 400 for IDENTITY.md (not in ALLOWED_FILES)", async () => {
    vi.mocked(readWorkspaceFile).mockImplementationOnce(() => {
      throw new Error("File not allowed: IDENTITY.md");
    });

    const request = makeGetRequest("agent-1", "IDENTITY.md");
    const response = await GET(request, makeParams("agent-1", "IDENTITY.md"));

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("File not allowed: IDENTITY.md");
  });

  it("should return empty string when file does not exist yet", async () => {
    vi.mocked(readWorkspaceFile).mockReturnValueOnce("");

    const request = makeGetRequest("agent-1", "SOUL.md");
    const response = await GET(request, makeParams("agent-1", "SOUL.md"));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.content).toBe("");
  });
});

describe("PUT /api/agents/[agentId]/files/[filename]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue({
      user: { id: "1", email: "admin@test.com" },
    } as any);
    vi.mocked(getAgentWithAccess).mockResolvedValue(defaultAgent);
    // Default: write is allowed. Individual tests override to simulate denial.
    mockRequireAgentWriteAccess.mockReturnValue(null);
  });

  it("should write file content and return success", async () => {
    const request = makePutRequest("agent-1", "SOUL.md", {
      content: "# Updated soul",
    });
    const response = await PUT(request, makeParams("agent-1", "SOUL.md"));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(writeWorkspaceFile).toHaveBeenCalledWith("agent-1", "SOUL.md", "# Updated soul");
  });

  it("should return 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const request = makePutRequest("agent-1", "SOUL.md", {
      content: "# Updated soul",
    });
    const response = await PUT(request, makeParams("agent-1", "SOUL.md"));

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe("Unauthorized");
  });

  it("forwards the getAgentWithAccess denial verbatim on write, whatever its status", async () => {
    // Synthetic 403 sentinel — see the GET case above.
    vi.mocked(getAgentWithAccess).mockResolvedValueOnce(
      NextResponse.json({ error: "Forbidden" }, { status: 403 })
    );

    const request = makePutRequest("agent-1", "SOUL.md", { content: "# Evil" });
    const response = await PUT(request, makeParams("agent-1", "SOUL.md"));

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe("Forbidden");
  });

  it("should return 404 when agent does not exist", async () => {
    vi.mocked(getAgentWithAccess).mockResolvedValueOnce(
      NextResponse.json({ error: "Agent not found" }, { status: 404 })
    );

    const request = makePutRequest("nonexistent", "SOUL.md", {
      content: "# Updated soul",
    });
    const response = await PUT(request, makeParams("nonexistent", "SOUL.md"));

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe("Agent not found");
  });

  it("should return 400 when filename is not allowed", async () => {
    vi.mocked(writeWorkspaceFile).mockImplementationOnce(() => {
      throw new Error("File not allowed: HACK.md");
    });

    const request = makePutRequest("agent-1", "HACK.md", {
      content: "malicious content",
    });
    const response = await PUT(request, makeParams("agent-1", "HACK.md"));

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("File not allowed: HACK.md");
  });

  it("should return 400 for USER.md PUT (no longer in ALLOWED_FILES)", async () => {
    vi.mocked(writeWorkspaceFile).mockImplementationOnce(() => {
      throw new Error("File not allowed: USER.md");
    });

    const request = makePutRequest("agent-1", "USER.md", {
      content: "# Team info",
    });
    const response = await PUT(request, makeParams("agent-1", "USER.md"));

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("File not allowed: USER.md");
  });

  it("should write AGENTS.md file", async () => {
    const request = makePutRequest("agent-1", "AGENTS.md", {
      content: "# Agent instructions",
    });
    const response = await PUT(request, makeParams("agent-1", "AGENTS.md"));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(writeWorkspaceFile).toHaveBeenCalledWith("agent-1", "AGENTS.md", "# Agent instructions");
  });

  it("should handle empty content", async () => {
    const request = makePutRequest("agent-1", "SOUL.md", {
      content: "",
    });
    const response = await PUT(request, makeParams("agent-1", "SOUL.md"));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(writeWorkspaceFile).toHaveBeenCalledWith("agent-1", "SOUL.md", "");
  });

  it("should return 400 when content field is missing", async () => {
    const request = makePutRequest("agent-1", "SOUL.md", {});
    const response = await PUT(request, makeParams("agent-1", "SOUL.md"));

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Validation failed");
    expect(data.details.fieldErrors.content).toBeDefined();
    expect(writeWorkspaceFile).not.toHaveBeenCalled();
  });

  it("should return 403 when non-admin tries to modify shared agent files", async () => {
    mockRequireAgentWriteAccess.mockReturnValueOnce(
      NextResponse.json({ error: "Forbidden" }, { status: 403 })
    );

    const request = makePutRequest("agent-1", "AGENTS.md", {
      content: "# Hacked instructions",
    });
    const response = await PUT(request, makeParams("agent-1", "AGENTS.md"));

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe("Forbidden");
    expect(writeWorkspaceFile).not.toHaveBeenCalled();
  });

  it("should allow write when requireAgentWriteAccess passes", async () => {
    mockRequireAgentWriteAccess.mockReturnValueOnce(null);

    const request = makePutRequest("agent-1", "AGENTS.md", {
      content: "# Valid update",
    });
    const response = await PUT(request, makeParams("agent-1", "AGENTS.md"));

    expect(response.status).toBe(200);
    expect(writeWorkspaceFile).toHaveBeenCalledWith("agent-1", "AGENTS.md", "# Valid update");
  });
});

// An agent's instructions decide how it behaves — which records it touches,
// which customer it prioritises. Until this landed, the route carried an
// `audit-exempt` comment and the memory-audit watcher covered MEMORY.md and
// memory/** only. So Pinchy audited what an agent wrote about itself and not
// the rules a person gave it, which is the governance story backwards.
describe("PUT /api/agents/[agentId]/files/[filename] — audit trail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue({
      user: { id: "1", email: "admin@test.com" },
    } as any);
    vi.mocked(getAgentWithAccess).mockResolvedValue(defaultAgent);
    mockRequireAgentWriteAccess.mockReturnValue(null);
    mockAppendAuditLog.mockResolvedValue(undefined);
  });

  it("records an agent.instructions_changed entry with the line diff", async () => {
    vi.mocked(readWorkspaceFile).mockReturnValueOnce("# Old\nkeep\ndrop\n");

    const request = makePutRequest("agent-1", "AGENTS.md", {
      content: "# Old\nkeep\nadded one\nadded two\n",
    });
    const response = await PUT(request, makeParams("agent-1", "AGENTS.md"));

    expect(response.status).toBe(200);
    expect(mockAppendAuditLog).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "1",
      eventType: "agent.instructions_changed",
      resource: "agent:agent-1",
      detail: {
        agent: { id: "agent-1", name: "Smithers" },
        file: "AGENTS.md",
        addedLines: 2,
        removedLines: 1,
        byteSize: "# Old\nkeep\nadded one\nadded two\n".length,
      },
      outcome: "success",
    });
  });

  it("sizes the file in UTF-8 bytes, like the memory sibling does", async () => {
    // The whole argument for this detail shape is that one query reads both
    // families. agent.memory_changed measures Buffer.byteLength(…, "utf8");
    // String.length counts UTF-16 code units, so the two disagree on every
    // non-ASCII file — and instructions written in German, or carrying a
    // single emoji, are the ordinary case rather than the exotic one.
    const content = "Prüfe die Rechnung für Kunde ☕\n";
    vi.mocked(readWorkspaceFile).mockReturnValueOnce("");

    await PUT(
      makePutRequest("agent-1", "AGENTS.md", { content }),
      makeParams("agent-1", "AGENTS.md")
    );

    expect(Buffer.byteLength(content, "utf8")).not.toBe(content.length);
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ byteSize: Buffer.byteLength(content, "utf8") }),
      })
    );
  });

  it("writes no entry when the save left the file unchanged", async () => {
    // The settings page PUTs SOUL.md whenever the Personality tab is dirty,
    // and that tab is dirty for an avatar or preset change too
    // (agent-settings-page-content.tsx). Auditing the write rather than the
    // change would therefore file "someone edited this agent's Personality"
    // against someone who picked a new avatar. A row that describes no change
    // is worse than no row: an auditor cannot tell it from a real edit.
    const unchanged = "# Same\ncontent\n";
    vi.mocked(readWorkspaceFile).mockReturnValueOnce(unchanged);

    const response = await PUT(
      makePutRequest("agent-1", "SOUL.md", { content: unchanged }),
      makeParams("agent-1", "SOUL.md")
    );

    expect(response.status).toBe(200);
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
    // The write still happens — it is what reclaims a root-owned file (#1095),
    // and skipping it would trade an audit fix for a production regression.
    expect(writeWorkspaceFile).toHaveBeenCalledWith("agent-1", "SOUL.md", unchanged);
  });

  it("names SOUL.md as the file rather than assuming instructions", async () => {
    // ALLOWED_FILES holds both, and they are different surfaces (Personality vs
    // Instructions). One event with the file in `detail` mirrors how
    // agent.memory_changed covers MEMORY.md and the notes under memory/.
    vi.mocked(readWorkspaceFile).mockReturnValueOnce("");

    await PUT(
      makePutRequest("agent-1", "SOUL.md", { content: "warm\n" }),
      makeParams("agent-1", "SOUL.md")
    );

    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ file: "SOUL.md" }) })
    );
  });

  it("never puts the instruction text itself in the audit detail", async () => {
    // The row is immutable and hash-chained, so anything written here cannot be
    // corrected later. Instructions are free text a user authored and may name
    // customers or internal rules; the diff shape says what changed without
    // copying it into a row nobody can edit.
    vi.mocked(readWorkspaceFile).mockReturnValueOnce("before\n");

    await PUT(
      makePutRequest("agent-1", "AGENTS.md", { content: "Call ACME before anyone else\n" }),
      makeParams("agent-1", "AGENTS.md")
    );

    const detail = JSON.stringify(mockAppendAuditLog.mock.calls[0][0].detail);
    expect(detail).not.toContain("ACME");
    expect(detail).not.toContain("before");
  });

  it("blocks the response until the entry is written", async () => {
    // An idempotent state change awaits its audit write (AGENTS.md § audit
    // rules): a fire-and-forget row can be lost exactly when the write it
    // describes succeeded.
    let resolveAudit: () => void = () => {};
    mockAppendAuditLog.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveAudit = resolve;
      })
    );

    let settled = false;
    const pending = PUT(
      makePutRequest("agent-1", "AGENTS.md", { content: "x\n" }),
      makeParams("agent-1", "AGENTS.md")
    ).then((res) => {
      settled = true;
      return res;
    });

    // Drain the microtask queue past the route's own awaits (params,
    // parseRequestBody). A single `await Promise.resolve()` would still be
    // pending for a fire-and-forget route and prove nothing.
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    resolveAudit();
    expect((await pending).status).toBe(200);
  });

  it("writes no entry when the caller may not write the file", async () => {
    mockRequireAgentWriteAccess.mockReturnValueOnce(
      NextResponse.json({ error: "Forbidden" }, { status: 403 })
    );

    const response = await PUT(
      makePutRequest("agent-1", "AGENTS.md", { content: "# Hacked" }),
      makeParams("agent-1", "AGENTS.md")
    );

    expect(response.status).toBe(403);
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("records a failure entry when the write itself fails", async () => {
    vi.mocked(readWorkspaceFile).mockReturnValueOnce("before\n");
    vi.mocked(writeWorkspaceFile).mockImplementationOnce(() => {
      throw new Error("EACCES: permission denied");
    });

    const response = await PUT(
      makePutRequest("agent-1", "AGENTS.md", { content: "after\n" }),
      makeParams("agent-1", "AGENTS.md")
    );

    expect(response.status).toBe(400);
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failure" })
    );
  });

  it("keeps the write's own error when the failure row cannot be stored", async () => {
    // Two things fail here: the file write, then the audit write describing it.
    // Only the first is the caller's problem, and it is the one that names the
    // cause (#1095 surfaces as EACCES). Awaiting the failure row the way the
    // success row is awaited would replace a 400 that explains itself with an
    // unhandled rejection — a 500 that explains nothing, over a row the caller
    // can do nothing about. The dropped row goes to recordAuditFailure instead,
    // which is the AGENTS.md pattern for an audit write that must not sink the
    // response.
    vi.mocked(readWorkspaceFile).mockReturnValueOnce("before\n");
    vi.mocked(writeWorkspaceFile).mockImplementationOnce(() => {
      throw new Error("EACCES: permission denied");
    });
    mockAppendAuditLog.mockRejectedValueOnce(new Error("audit db unreachable"));

    const response = await PUT(
      makePutRequest("agent-1", "AGENTS.md", { content: "after\n" }),
      makeParams("agent-1", "AGENTS.md")
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "EACCES: permission denied" });
    expect(mockRecordAuditFailure).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ eventType: "agent.instructions_changed", outcome: "failure" })
    );
  });

  it("fails the request when the success row cannot be stored", async () => {
    // The other half of "awaited, not deferred": rewriting a file is
    // idempotent, so a request that cannot be audited is one the caller may
    // safely retry. Answering 200 would report a change Pinchy has no record
    // of — which is the failure the audit trail exists to prevent.
    vi.mocked(readWorkspaceFile).mockReturnValueOnce("before\n");
    mockAppendAuditLog.mockRejectedValueOnce(new Error("audit db unreachable"));

    await expect(
      PUT(
        makePutRequest("agent-1", "AGENTS.md", { content: "after\n" }),
        makeParams("agent-1", "AGENTS.md")
      )
    ).rejects.toThrow("audit db unreachable");
  });

  it("writes no entry when the filename is not an allowed file", async () => {
    // A rejected filename changes nothing on disk and is a client-side typo,
    // not an action on the agent. Auditing it would fill the trail with rows
    // that describe no state.
    vi.mocked(readWorkspaceFile).mockImplementationOnce(() => {
      throw new Error("File not allowed: SECRET.md");
    });

    const response = await PUT(
      makePutRequest("agent-1", "SECRET.md", { content: "x" }),
      makeParams("agent-1", "SECRET.md")
    );

    expect(response.status).toBe(400);
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });
});
