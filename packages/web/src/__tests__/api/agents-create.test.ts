import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { id: "1", email: "admin@test.com" } }),
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

import { POST } from "@/app/api/agents/route";
import { NextRequest } from "next/server";
import { validateAllowedPaths } from "@/lib/path-validation";
import { ensureWorkspace, writeWorkspaceFile } from "@/lib/workspace";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { AGENT_TEMPLATES } from "@/lib/agent-templates";

describe("POST /api/agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("should create a knowledge-base agent without pluginConfig (set later via Permissions tab)", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "HR Knowledge Base",
        templateId: "knowledge-base",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);
    expect(validateAllowedPaths).not.toHaveBeenCalled();
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginConfig: null,
      })
    );
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

  it("should set greetingMessage from template's defaultGreeting", async () => {
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
        greetingMessage: AGENT_TEMPLATES["knowledge-base"].defaultGreeting,
      })
    );
  });

  it("should set greetingMessage to null for custom template", async () => {
    const request = new NextRequest("http://localhost:7777/api/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Dev Assistant",
        templateId: "custom",
      }),
    });

    await POST(request);

    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        greetingMessage: null,
      })
    );
  });
});
