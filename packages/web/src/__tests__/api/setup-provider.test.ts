import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { POST } from "@/app/api/setup/provider/route";

vi.mock("@/lib/api-auth", () => ({
  requireAdmin: vi
    .fn()
    .mockResolvedValue({ user: { id: "1", email: "admin@test.com", role: "admin" } }),
}));

vi.mock("@/lib/providers", () => ({
  validateProviderKey: vi.fn().mockResolvedValue({ valid: true }),
  PROVIDERS: {
    anthropic: {
      name: "Anthropic",
      settingsKey: "anthropic_api_key",
      envVar: "ANTHROPIC_API_KEY",
      defaultModel: "anthropic/claude-haiku-4-5-20251001",
      placeholder: "sk-ant-...",
    },
    openai: {
      name: "OpenAI",
      settingsKey: "openai_api_key",
      envVar: "OPENAI_API_KEY",
      defaultModel: "openai/gpt-4o-mini",
      placeholder: "sk-...",
    },
    google: {
      name: "Google",
      settingsKey: "google_api_key",
      envVar: "GEMINI_API_KEY",
      defaultModel: "google/gemini-2.5-flash",
      placeholder: "AIza...",
    },
    ollama: {
      name: "Ollama",
      settingsKey: "ollama_api_key",
      envVar: "OLLAMA_API_KEY",
      defaultModel: "ollama-cloud/gemini-3-flash-preview:cloud",
      placeholder: "sk-...",
    },
  },
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/openclaw-config", () => ({
  writeOpenClawConfig: vi.fn(),
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/provider-models", () => ({
  resetCache: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    query: {
      agents: {
        findFirst: vi.fn().mockResolvedValue({
          id: "agent-1",
          name: "Smithers",
          model: "anthropic/claude-sonnet-4-20250514",
        }),
      },
    },
  },
}));

import { validateProviderKey } from "@/lib/providers";
import { getSetting, setSetting } from "@/lib/settings";
import { writeOpenClawConfig, regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { db } from "@/db";
import { requireAdmin } from "@/lib/api-auth";
import { resetCache } from "@/lib/provider-models";

describe("POST /api/setup/provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(db.query.agents.findFirst).mockResolvedValue({
      id: "agent-1",
      name: "Smithers",
      model: "anthropic/claude-sonnet-4-20250514",
    });
  });

  function makeRequest(body: Record<string, unknown>) {
    return new Request("http://localhost/api/setup/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("should return 200 on valid provider and key", async () => {
    const response = await POST(
      makeRequest({
        provider: "anthropic",
        apiKey: "sk-ant-valid",
      }) as any
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });

  it("should validate the API key", async () => {
    await POST(
      makeRequest({
        provider: "anthropic",
        apiKey: "sk-ant-key",
      }) as any
    );

    expect(validateProviderKey).toHaveBeenCalledWith("anthropic", "sk-ant-key");
  });

  it("should store provider key encrypted", async () => {
    await POST(
      makeRequest({
        provider: "anthropic",
        apiKey: "sk-ant-key",
      }) as any
    );

    expect(setSetting).toHaveBeenCalledWith("anthropic_api_key", "sk-ant-key", true);
    expect(setSetting).toHaveBeenCalledWith("default_provider", "anthropic", false);
  });

  it("should update agent model when adding the first provider", async () => {
    // No other providers configured (getSetting returns null for all)
    await POST(
      makeRequest({
        provider: "openai",
        apiKey: "sk-key",
      }) as any
    );

    expect(db.update).toHaveBeenCalled();
  });

  it("should not update agent model when a second provider is added", async () => {
    // OpenAI is already configured
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "openai_api_key") return "sk-openai-existing";
      return null;
    });

    await POST(
      makeRequest({
        provider: "anthropic",
        apiKey: "sk-ant-key",
      }) as any
    );

    expect(db.update).not.toHaveBeenCalled();
  });

  it("should regenerate full OpenClaw config including agent list", async () => {
    await POST(
      makeRequest({
        provider: "anthropic",
        apiKey: "sk-ant-key",
      }) as any
    );

    expect(regenerateOpenClawConfig).toHaveBeenCalled();
  });

  it("should reset model cache after saving provider", async () => {
    await POST(
      makeRequest({
        provider: "anthropic",
        apiKey: "sk-ant-key",
      }) as any
    );

    expect(resetCache).toHaveBeenCalled();
  });

  it("should return 400 for invalid provider", async () => {
    const response = await POST(
      makeRequest({
        provider: "unknown",
        apiKey: "key",
      }) as any
    );

    expect(response.status).toBe(400);
  });

  it("should return 400 for missing apiKey", async () => {
    const response = await POST(
      makeRequest({
        provider: "anthropic",
      }) as any
    );

    expect(response.status).toBe(400);
  });

  it("should return 422 when key is invalid", async () => {
    vi.mocked(validateProviderKey).mockResolvedValueOnce({ valid: false, error: "invalid_key" });

    const response = await POST(
      makeRequest({
        provider: "anthropic",
        apiKey: "sk-ant-invalid",
      }) as any
    );

    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.error).toContain("Invalid API key");
  });

  it("should return 502 when provider API is unreachable", async () => {
    vi.mocked(validateProviderKey).mockResolvedValueOnce({ valid: false, error: "network_error" });

    const response = await POST(
      makeRequest({
        provider: "anthropic",
        apiKey: "sk-ant-key",
      }) as any
    );

    expect(response.status).toBe(502);
    const data = await response.json();
    expect(data.error).toContain("Could not reach");
  });

  it("should return 502 with helpful message when provider returns server error", async () => {
    vi.mocked(validateProviderKey).mockResolvedValueOnce({
      valid: false,
      error: "provider_error",
      status: 500,
    });

    const response = await POST(
      makeRequest({
        provider: "anthropic",
        apiKey: "sk-ant-key",
      }) as any
    );

    expect(response.status).toBe(502);
    const data = await response.json();
    expect(data.error).toContain("key may be valid");
    expect(data.error).toContain("500");
  });

  it("should return 401 when not authenticated", async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );

    const response = await POST(
      makeRequest({
        provider: "anthropic",
        apiKey: "sk-ant-key",
      }) as any
    );

    expect(response.status).toBe(401);
  });

  it("should return 403 when non-admin user tries to configure provider", async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce(
      NextResponse.json({ error: "Forbidden" }, { status: 403 })
    );

    const response = await POST(
      makeRequest({
        provider: "anthropic",
        apiKey: "sk-ant-valid",
      }) as any
    );

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe("Forbidden");
  });
});
