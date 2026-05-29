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
  setOllamaLocalModels: vi.fn(),
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

vi.mock("@/lib/model-resolver", () => ({
  resolveModelForTemplate: vi.fn().mockResolvedValue({
    model: "anthropic/claude-sonnet-4-6",
    reason: "balanced",
    fallbackUsed: false,
  }),
}));

vi.mock("@/lib/personal-agent", () => ({
  SMITHERS_MODEL_HINT: { tier: "balanced", capabilities: ["tools", "long-context"] },
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
import {
  resetCache,
  getDefaultModel,
  fetchOllamaLocalModelsFromUrl,
  setOllamaLocalModels,
} from "@/lib/provider-models";
import { resolveModelForTemplate } from "@/lib/model-resolver";
import { TemplateCapabilityUnavailableError } from "@/lib/model-resolver/types";
import { SMITHERS_MODEL_HINT } from "@/lib/personal-agent";

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

  it("primes the ollama-local model cache so Smithers resolves to an ollama model", async () => {
    // Regression for the ollama-local wizard bug: resolveModelForTemplate
    // reads getOllamaLocalModels() (the lastOllamaLocalModels cache), which is
    // only populated by fetchProviderModels() — NOT by the wizard's direct
    // fetchOllamaLocalModelsFromUrl() call. Without priming the cache here,
    // resolveOllamaLocal() sees an empty model list, throws
    // TemplateCapabilityUnavailableError, and Smithers stays on the
    // anthropic/claude-sonnet-4-6 cold-start fallback — so a fresh ollama-local
    // install hits "No API key found for provider 'anthropic'" on first chat.
    await POST(
      makeRequest({
        provider: "ollama-local",
        url: "http://host.docker.internal:11434",
      }) as any
    );

    expect(setOllamaLocalModels).toHaveBeenCalledWith([
      {
        id: "ollama/qwen2.5:7b",
        name: "qwen2.5:7b",
        parameterSize: "7B",
        compatible: true,
        capabilities: { tools: true, vision: false, completion: true, thinking: false },
      },
    ]);
  });

  // #296 — Save-time rejection of hosts that won't pass OpenClaw's
  // isLocalBaseUrl allowlist. The unit test in providers.test.ts covers the
  // detection; here we just pin the route's surface contract so the UI can
  // render a helpful hint instead of silent runtime failure at chat time.
  it("returns 422 with an inline message that names the offending host (#296)", async () => {
    vi.mocked(validateProviderUrl).mockResolvedValueOnce({
      valid: false,
      error: "unsupported_local_host",
      host: "ollama",
    });

    const response = await POST(
      makeRequest({
        provider: "ollama-local",
        url: "http://ollama:11434",
      }) as any
    );
    expect(response.status).toBe(422);
    const data = await response.json();
    // The error must name the offending host so the user can find their
    // typo. The docs link is returned as a structured `docs` field (see the
    // next test) so the UI can render it as a clickable anchor rather than
    // a long URL squashed into the prose.
    expect(data.error).toContain("ollama");
    expect(data.error).not.toMatch(/https?:\/\//); // no URL in the prose
  });

  // #296 review follow-up — return docs link as structured metadata so the
  // form can render it as a clickable <a>, instead of forcing the user to
  // copy-paste a URL from inline error text.
  it("returns structured docs metadata so the UI can render a clickable hint (#296)", async () => {
    vi.mocked(validateProviderUrl).mockResolvedValueOnce({
      valid: false,
      error: "unsupported_local_host",
      host: "ollama",
    });

    const response = await POST(
      makeRequest({
        provider: "ollama-local",
        url: "http://ollama:11434",
      }) as any
    );
    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.docs).toBeDefined();
    expect(typeof data.docs.label).toBe("string");
    expect(data.docs.label.length).toBeGreaterThan(0);
    // Must point at option B of the Ollama setup guide so the fix is one
    // click away, not buried in a longer troubleshooting page.
    expect(data.docs.href).toMatch(/^https?:\/\//);
    expect(data.docs.href).toMatch(/guides\/ollama-setup/);
    expect(data.docs.href).toMatch(/b-ollama-as-a-docker-service/);
  });

  it("does not save the provider when ollama-local URL host is unsupported (#296)", async () => {
    vi.mocked(validateProviderUrl).mockResolvedValueOnce({
      valid: false,
      error: "unsupported_local_host",
      host: "ollama",
    });

    await POST(
      makeRequest({
        provider: "ollama-local",
        url: "http://ollama:11434",
      }) as any
    );
    // No setSetting calls at all — the URL must not land in the DB.
    expect(setSetting).not.toHaveBeenCalled();
    expect(regenerateOpenClawConfig).not.toHaveBeenCalled();
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

  it("updates Smithers' model using SMITHERS_MODEL_HINT when provider is configured as first provider", async () => {
    vi.mocked(resolveModelForTemplate).mockResolvedValueOnce({
      model: "anthropic/claude-sonnet-4-6",
      reason: "balanced tier",
      fallbackUsed: false,
    });

    await POST(
      makeRequest({
        provider: "anthropic",
        apiKey: "sk-ant-key",
      }) as any
    );

    expect(resolveModelForTemplate).toHaveBeenCalledWith({
      hint: SMITHERS_MODEL_HINT,
      provider: "anthropic",
    });
    expect(db.update).toHaveBeenCalled();
    // getDefaultModel must NOT be called — the route must use resolveModelForTemplate
    expect(getDefaultModel).not.toHaveBeenCalled();
  });

  it("updates Smithers' model via SMITHERS_MODEL_HINT for ollama-local as first provider", async () => {
    vi.mocked(resolveModelForTemplate).mockResolvedValueOnce({
      model: "ollama/qwen2.5:7b",
      reason: "balanced tier",
      fallbackUsed: false,
    });

    await POST(
      makeRequest({
        provider: "ollama-local",
        url: "http://host.docker.internal:11434",
      }) as any
    );

    expect(resolveModelForTemplate).toHaveBeenCalledWith({
      hint: SMITHERS_MODEL_HINT,
      provider: "ollama-local",
    });
    expect(db.update).toHaveBeenCalled();
    expect(getDefaultModel).not.toHaveBeenCalled();
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

  it("succeeds with 200 even when resolveModelForTemplate throws TemplateCapabilityUnavailableError", async () => {
    // Provider is being added as the first provider, but resolver finds no
    // matching model — e.g. an Ollama instance with only text-only models.
    vi.mocked(resolveModelForTemplate).mockRejectedValueOnce(
      new TemplateCapabilityUnavailableError(["tools"], "anthropic", "https://docs.heypinchy.com")
    );

    const response = await POST(
      makeRequest({
        provider: "anthropic",
        apiKey: "sk-ant-key",
      }) as any
    );

    // Provider is still saved and route returns 200.
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(setSetting).toHaveBeenCalledWith("anthropic_api_key", "sk-ant-key", true);
    // Smithers' model must NOT be updated because resolution failed.
    expect(db.update).not.toHaveBeenCalled();
  });
});
