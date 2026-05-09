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
  validateProviderUrl: vi.fn().mockResolvedValue({ valid: true }),
  PROVIDERS: {
    anthropic: {
      name: "Anthropic",
      authType: "api-key",
      settingsKey: "anthropic_api_key",
      envVar: "ANTHROPIC_API_KEY",
      defaultModel: "anthropic/claude-haiku-4-5-20251001",
      placeholder: "sk-ant-...",
    },
    openai: {
      name: "OpenAI",
      authType: "api-key",
      settingsKey: "openai_api_key",
      envVar: "OPENAI_API_KEY",
      defaultModel: "openai/gpt-5.4-mini",
      placeholder: "sk-...",
    },
    google: {
      name: "Google",
      authType: "api-key",
      settingsKey: "google_api_key",
      envVar: "GEMINI_API_KEY",
      defaultModel: "google/gemini-2.5-flash",
      placeholder: "AIza...",
    },
    "ollama-cloud": {
      name: "Ollama Cloud",
      authType: "api-key",
      settingsKey: "ollama_cloud_api_key",
      envVar: "OLLAMA_CLOUD_API_KEY",
      defaultModel: "ollama-cloud/gemini-3-flash-preview",
      placeholder: "sk-...",
    },
    "ollama-local": {
      name: "Ollama (Local)",
      authType: "url",
      settingsKey: "ollama_local_url",
      envVar: "",
      defaultModel: "",
      placeholder: "http://host.docker.internal:11434",
    },
  },
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/provider-models", () => ({
  resetCache: vi.fn(),
  getDefaultModel: vi.fn().mockResolvedValue("ollama/llama3:latest"),
  fetchOllamaLocalModelsFromUrl: vi.fn().mockResolvedValue([
    {
      id: "ollama/qwen2.5:7b",
      name: "qwen2.5:7b",
      parameterSize: "7B",
      compatible: true,
      capabilities: { tools: true, vision: false, completion: true, thinking: false },
    },
  ]),
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

import { validateProviderKey, validateProviderUrl } from "@/lib/providers";
import { getSetting, setSetting } from "@/lib/settings";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { appendAuditLog } from "@/lib/audit";
import { db } from "@/db";
import { requireAdmin } from "@/lib/api-auth";
import { resetCache, getDefaultModel, fetchOllamaLocalModelsFromUrl } from "@/lib/provider-models";

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

  it("should accept ollama-local with URL instead of API key", async () => {
    const response = await POST(
      makeRequest({
        provider: "ollama-local",
        url: "http://host.docker.internal:11434",
      }) as any
    );
    expect(response.status).toBe(200);
    expect(setSetting).toHaveBeenCalledWith(
      "ollama_local_url",
      "http://host.docker.internal:11434",
      false
    );
  });

  it("should return 400 when ollama-local is missing URL", async () => {
    const response = await POST(makeRequest({ provider: "ollama-local" }) as any);
    expect(response.status).toBe(400);
  });

  it("should return 502 when ollama-local URL is unreachable", async () => {
    vi.mocked(validateProviderUrl).mockResolvedValueOnce({
      valid: false,
      error: "network_error",
    });

    const response = await POST(
      makeRequest({
        provider: "ollama-local",
        url: "http://bad-host:11434",
      }) as any
    );
    expect(response.status).toBe(502);
    const data = await response.json();
    expect(data.error).toContain("Could not connect to Ollama");
  });

  it("should return 502 when ollama-local returns an error status", async () => {
    vi.mocked(validateProviderUrl).mockResolvedValueOnce({
      valid: false,
      error: "provider_error",
      status: 500,
    });

    const response = await POST(
      makeRequest({
        provider: "ollama-local",
        url: "http://host.docker.internal:11434",
      }) as any
    );
    expect(response.status).toBe(502);
    const data = await response.json();
    expect(data.error).toContain("500");
  });

  it("should return 422 when ollama-local has no tool-capable models", async () => {
    vi.mocked(fetchOllamaLocalModelsFromUrl).mockResolvedValueOnce([
      {
        id: "ollama/phi3:mini",
        name: "phi3:mini",
        parameterSize: "3.8B",
        compatible: false,
        incompatibleReason: "Not compatible",
        capabilities: { tools: false, vision: false, completion: true, thinking: false },
      },
    ]);

    const response = await POST(
      makeRequest({ provider: "ollama-local", url: "http://host.docker.internal:11434" }) as any
    );
    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.error).toContain("qwen2.5");
  });

  it("should return 422 when ollama-local has zero models", async () => {
    vi.mocked(fetchOllamaLocalModelsFromUrl).mockResolvedValueOnce([]);

    const response = await POST(
      makeRequest({ provider: "ollama-local", url: "http://host.docker.internal:11434" }) as any
    );
    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.error).toContain("No");
  });

  it("should set dynamically resolved default model for ollama-local as first provider", async () => {
    vi.mocked(getDefaultModel).mockResolvedValueOnce("ollama/llama3:latest");

    await POST(
      makeRequest({
        provider: "ollama-local",
        url: "http://host.docker.internal:11434",
      }) as any
    );

    expect(getDefaultModel).toHaveBeenCalledWith("ollama-local");
    expect(db.update).toHaveBeenCalled();
  });

  it("writes an audit log entry with named provider snapshot for an api-key provider", async () => {
    await POST(
      makeRequest({
        provider: "anthropic",
        apiKey: "sk-ant-key",
      }) as any
    );

    expect(appendAuditLog).toHaveBeenCalledTimes(1);
    const call = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(call.actorType).toBe("user");
    expect(call.eventType).toBe("config.changed");
    // CLAUDE.md convention: snapshot human-readable name + id, not just id
    expect(call.detail).toMatchObject({
      provider: { id: "anthropic", name: "Anthropic" },
      authType: "api-key",
    });
  });

  // ── #177 regression: saving a provider key must NOT restart Pinchy ──────
  // The original bug (v0.4.4) was that this route called process.exit(0) to
  // force a restart so OpenClaw could pick up the new key. That broke open
  // browser tabs: their Server Action IDs no longer matched the freshly-built
  // server, so the chat panel reverted to its initial empty state. The fix
  // was to rely on OpenClaw's hot-reload of the regenerated config instead.
  // This guard fails fast if anyone re-introduces a process.exit (or its
  // equivalent) into the api-key or url-based code path.
  it("does not call process.exit on api-key provider save (regression for #177)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    try {
      const response = await POST(
        makeRequest({
          provider: "anthropic",
          apiKey: "sk-ant-key",
        }) as any
      );
      expect(response.status).toBe(200);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("does not call process.exit on url-based provider save (regression for #177)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    try {
      const response = await POST(
        makeRequest({
          provider: "ollama-local",
          url: "http://host.docker.internal:11434",
        }) as any
      );
      expect(response.status).toBe(200);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("writes an audit log entry for a url-based provider without leaking the URL", async () => {
    await POST(
      makeRequest({
        provider: "ollama-local",
        url: "http://host.docker.internal:11434",
      }) as any
    );

    expect(appendAuditLog).toHaveBeenCalledTimes(1);
    const detail = vi.mocked(appendAuditLog).mock.calls[0][0].detail as Record<string, unknown>;
    expect(detail).toMatchObject({
      provider: { id: "ollama-local", name: "Ollama (Local)" },
      authType: "url",
    });
    // The full URL must not appear in the audit log — it can leak internal
    // hostnames. Host:port is fine for traceability.
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain("http://host.docker.internal:11434");
    // ...but the host:port is acceptable as a non-secret diagnostic
    expect(detail).toMatchObject({ host: "host.docker.internal:11434" });
  });
});
