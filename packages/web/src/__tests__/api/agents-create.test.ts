import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { id: "1", email: "admin@test.com", role: "admin" } }),
}));

const { insertValuesMock } = vi.hoisted(() => ({
  insertValuesMock: vi.fn(),
}));
vi.mock("@/db", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: insertValuesMock.mockReturnValue({
        returning: vi.fn().mockResolvedValue([
          {
            id: "new-agent-id",
            name: "HR Knowledge Base",
            model: "anthropic/claude-haiku-4-5-20251001",
            templateId: "knowledge-base",
            pluginConfig: { allowed_paths: ["/data/hr-docs/"] },
            ownerId: "1",
            tagline: "Answer questions from your docs",
          },
        ]),
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockResolvedValue([]),
    }),
  },
}));

vi.mock("@/lib/workspace", () => ({
  ensureWorkspace: vi.fn(),
  writeWorkspaceFile: vi.fn(),
  writeIdentityFile: vi.fn(),
}));

vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/path-validation", () => ({
  validateAllowedPaths: vi.fn((paths: string[]) =>
    paths.map((p) => (p.endsWith("/") ? p : p + "/"))
  ),
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue("anthropic"),
}));

vi.mock("@/lib/personality-presets", () => ({
  getPersonalityPreset: vi.fn((id: string) => {
    const presets: Record<string, { greetingMessage: string | null; soulMd: string }> = {
      "the-professor": {
        greetingMessage:
          "Hello! I'm {name}, and I'm here to help you find answers in your documents.",
        soulMd: "# Professor SOUL.md",
      },
      "the-butler": {
        greetingMessage: "Good day. I'm {name}. How may I be of assistance?",
        soulMd: "# Butler SOUL.md",
      },
    };
    return presets[id];
  }),
  resolveGreetingMessage: (greeting: string | null, name: string) =>
    greeting ? greeting.replace("{name}", name) : null,
}));

vi.mock("@/lib/avatar", () => ({
  generateAvatarSeed: vi.fn().mockReturnValue("mock-seed-uuid"),
}));

import { POST } from "@/app/api/agents/route";
import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { validateAllowedPaths } from "@/lib/path-validation";
import { ensureWorkspace, writeWorkspaceFile, writeIdentityFile } from "@/lib/workspace";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";

describe("POST /api/agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return 403 for non-admin users", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: { id: "2", email: "user@test.com", role: "user" },
      expires: "",
    });

    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Test Agent",
        templateId: "custom",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe("Admin access required");
  });

  it("should create an agent from a knowledge-base template", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "HR Knowledge Base",
        templateId: "knowledge-base",
        pluginConfig: {
          allowed_paths: ["/data/hr-docs/"],
        },
      }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.name).toBe("HR Knowledge Base");
    expect(body.templateId).toBe("knowledge-base");
    expect(validateAllowedPaths).toHaveBeenCalledWith(["/data/hr-docs/"]);
    expect(ensureWorkspace).toHaveBeenCalledWith("new-agent-id");
    expect(writeWorkspaceFile).toHaveBeenCalledWith("new-agent-id", "SOUL.md", expect.any(String));
    expect(regenerateOpenClawConfig).toHaveBeenCalled();
  });

  it("should set ownerId to the current user's id", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "HR Knowledge Base",
        templateId: "knowledge-base",
        pluginConfig: {
          allowed_paths: ["/data/hr-docs/"],
        },
      }),
    });

    await POST(request);

    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "1",
      })
    );
  });

  it("should set allowedTools from template", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "HR Knowledge Base",
        templateId: "knowledge-base",
        pluginConfig: {
          allowed_paths: ["/data/hr-docs/"],
        },
      }),
    });

    await POST(request);

    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedTools: ["pinchy_ls", "pinchy_read"],
      })
    );
  });

  it("should reject name longer than 30 characters", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "A".repeat(31),
        templateId: "custom",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/name/i);
  });

  it("should accept name with exactly 30 characters", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "A".repeat(30),
        templateId: "custom",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);
  });

  it("should reject unknown template", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Test",
        templateId: "nonexistent",
        pluginConfig: {},
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("should reject knowledge-base agent without allowed_paths", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "HR Knowledge Base",
        templateId: "knowledge-base",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("At least one directory must be selected");
  });

  it("should create a custom agent without pluginConfig", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Dev Assistant",
        templateId: "custom",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);
    expect(validateAllowedPaths).not.toHaveBeenCalled();
  });

  it("should set greetingMessage from personality preset", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "HR Knowledge Base",
        templateId: "knowledge-base",
        pluginConfig: {
          allowed_paths: ["/data/hr-docs/"],
        },
      }),
    });

    await POST(request);

    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        greetingMessage:
          "Hello! I'm HR Knowledge Base, and I'm here to help you find answers in your documents.",
        personalityPresetId: "the-professor",
      })
    );
  });

  it("should set avatarSeed from generateAvatarSeed", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "HR Knowledge Base",
        templateId: "knowledge-base",
        pluginConfig: {
          allowed_paths: ["/data/hr-docs/"],
        },
      }),
    });

    await POST(request);

    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        avatarSeed: "mock-seed-uuid",
      })
    );
  });

  it("should write SOUL.md from personality preset", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "HR Knowledge Base",
        templateId: "knowledge-base",
        pluginConfig: {
          allowed_paths: ["/data/hr-docs/"],
        },
      }),
    });

    await POST(request);

    expect(writeWorkspaceFile).toHaveBeenCalledWith(
      "new-agent-id",
      "SOUL.md",
      "# Professor SOUL.md"
    );
  });

  it("should use tagline from request body when provided", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "HR Bot",
        templateId: "custom",
        tagline: "Custom tagline",
      }),
    });

    await POST(request);

    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tagline: "Custom tagline",
      })
    );
  });

  it("should call writeIdentityFile after creating agent", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "HR Knowledge Base",
        templateId: "knowledge-base",
        pluginConfig: {
          allowed_paths: ["/data/hr-docs/"],
        },
      }),
    });

    await POST(request);

    expect(writeIdentityFile).toHaveBeenCalledWith("new-agent-id", {
      name: "HR Knowledge Base",
      tagline: "Answer questions from your docs",
    });
  });

  it("should write AGENTS.md when template has defaultAgentsMd", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "HR Knowledge Base",
        templateId: "knowledge-base",
        pluginConfig: {
          allowed_paths: ["/data/hr-docs/"],
        },
      }),
    });

    await POST(request);

    expect(writeWorkspaceFile).toHaveBeenCalledWith(
      "new-agent-id",
      "AGENTS.md",
      expect.stringContaining("knowledge base agent")
    );
  });

  it("should not write AGENTS.md when template has null defaultAgentsMd", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Dev Assistant",
        templateId: "custom",
      }),
    });

    await POST(request);

    expect(writeWorkspaceFile).not.toHaveBeenCalledWith(
      expect.anything(),
      "AGENTS.md",
      expect.anything()
    );
  });

  it("should use template defaultTagline when tagline not provided", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "HR Knowledge Base",
        templateId: "knowledge-base",
        pluginConfig: {
          allowed_paths: ["/data/hr-docs/"],
        },
      }),
    });

    await POST(request);

    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tagline: "Answer questions from your docs",
      })
    );
  });
});
