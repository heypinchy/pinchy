import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { id: "1", email: "admin@test.com" } }),
}));

vi.mock("@/lib/workspace", () => ({
  readWorkspaceFile: vi.fn().mockReturnValue("# Soul content"),
  writeWorkspaceFile: vi.fn(),
}));

const { mockNotifyRestart } = vi.hoisted(() => ({
  mockNotifyRestart: vi.fn(),
}));
vi.mock("@/server/restart-state", () => ({
  restartState: { notifyRestart: mockNotifyRestart },
}));

vi.mock("@/lib/agent-access", () => ({
  getAgentWithAccess: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { readWorkspaceFile, writeWorkspaceFile } from "@/lib/workspace";
import { getAgentWithAccess } from "@/lib/agent-access";
import { GET, PUT } from "@/app/api/agents/[agentId]/files/[filename]/route";

const defaultAgent = {
  id: "agent-1",
  name: "Smithers",
  model: "anthropic/claude-sonnet-4-20250514",
  ownerId: null,
  isPersonal: false,
  createdAt: new Date(),
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
    vi.mocked(auth).mockResolvedValue({ user: { id: "1", email: "admin@test.com" } } as any);
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
    vi.mocked(auth).mockResolvedValueOnce(null);

    const request = makeGetRequest("agent-1", "SOUL.md");
    const response = await GET(request, makeParams("agent-1", "SOUL.md"));

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe("Unauthorized");
  });

  it("should return 403 when user has no access to agent", async () => {
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

  it("should read USER.md file", async () => {
    vi.mocked(readWorkspaceFile).mockReturnValueOnce("# User context");

    const request = makeGetRequest("agent-1", "USER.md");
    const response = await GET(request, makeParams("agent-1", "USER.md"));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.content).toBe("# User context");
    expect(readWorkspaceFile).toHaveBeenCalledWith("agent-1", "USER.md");
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
    vi.mocked(auth).mockResolvedValue({ user: { id: "1", email: "admin@test.com" } } as any);
    vi.mocked(getAgentWithAccess).mockResolvedValue(defaultAgent);
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
    vi.mocked(auth).mockResolvedValueOnce(null);

    const request = makePutRequest("agent-1", "SOUL.md", {
      content: "# Updated soul",
    });
    const response = await PUT(request, makeParams("agent-1", "SOUL.md"));

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe("Unauthorized");
  });

  it("should return 403 when user has no access to agent", async () => {
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

  it("should write USER.md file", async () => {
    const request = makePutRequest("agent-1", "USER.md", {
      content: "# Team info",
    });
    const response = await PUT(request, makeParams("agent-1", "USER.md"));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(writeWorkspaceFile).toHaveBeenCalledWith("agent-1", "USER.md", "# Team info");
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
    expect(data.error).toBe("content must be a string");
    expect(writeWorkspaceFile).not.toHaveBeenCalled();
  });

  it("should trigger OpenClaw restart after writing file", async () => {
    const request = makePutRequest("agent-1", "SOUL.md", {
      content: "# Updated soul",
    });
    await PUT(request, makeParams("agent-1", "SOUL.md"));

    expect(mockNotifyRestart).toHaveBeenCalled();
  });

  it("should not trigger restart when file write fails", async () => {
    vi.mocked(writeWorkspaceFile).mockImplementationOnce(() => {
      throw new Error("File not allowed: HACK.md");
    });

    const request = makePutRequest("agent-1", "HACK.md", {
      content: "malicious content",
    });
    await PUT(request, makeParams("agent-1", "HACK.md"));

    expect(mockNotifyRestart).not.toHaveBeenCalled();
  });
});
