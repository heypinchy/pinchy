import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET, DELETE } from "@/app/api/settings/providers/route";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => {
  const mockGetSession = vi.fn().mockResolvedValue({
    user: { id: "1", email: "admin@test.com", role: "admin" },
  });
  return {
    getSession: mockGetSession,
    auth: {
      api: {
        getSession: mockGetSession,
      },
    },
  };
});

vi.mock("@/lib/providers", () => ({
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
      defaultModel: "openai/gpt-4o-mini",
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
  deleteSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/provider-models", () => ({
  resetCache: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {
    query: {
      agents: {
        findFirst: vi.fn().mockResolvedValue({ id: "agent-1" }),
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    }),
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    eq: vi.fn(),
  };
});

import { auth } from "@/lib/auth";
import { getSetting, deleteSetting, setSetting } from "@/lib/settings";
import { resetCache } from "@/lib/provider-models";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { db } from "@/db";

describe("GET /api/settings/providers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSetting).mockResolvedValue(null);
  });

  it("should return 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const response = await GET();

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe("Unauthorized");
  });

  it("should return all providers as not configured when nothing is set", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      defaultProvider: null,
      providers: {
        anthropic: { configured: false },
        openai: { configured: false },
        google: { configured: false },
        "ollama-cloud": { configured: false },
        "ollama-local": { configured: false },
      },
    });
  });

  it("should return configured: true for a provider with a stored key", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-secret-key-xY9z";
      return null;
    });

    const response = await GET();

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.providers.anthropic.configured).toBe(true);
    expect(data.providers.openai.configured).toBe(false);
    expect(data.providers.google.configured).toBe(false);
  });

  it("should return hint with last 4 characters of the key", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-secret-key-xY9z";
      return null;
    });

    const response = await GET();
    const data = await response.json();

    expect(data.providers.anthropic.hint).toBe("xY9z");
    expect(data.providers.openai.hint).toBeUndefined();
    expect(data.providers.google.hint).toBeUndefined();
  });

  it("should not return hints for non-admin users", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "2", email: "user@test.com", role: "member" },
    } as any);
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-secret-key-xY9z";
      return null;
    });

    const response = await GET();

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.providers.anthropic.configured).toBe(true);
    expect(data.providers.anthropic.hint).toBeUndefined();
  });

  it("should return correct defaultProvider value", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "default_provider") return "anthropic";
      if (key === "anthropic_api_key") return "sk-ant-secret";
      return null;
    });

    const response = await GET();

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.defaultProvider).toBe("anthropic");
  });

  it("should return full URL as hint for ollama-local", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "ollama_local_url") return "http://host.docker.internal:11434";
      return null;
    });

    const response = await GET();
    const data = await response.json();
    expect(data.providers["ollama-local"].configured).toBe(true);
    expect(data.providers["ollama-local"].hint).toBe("http://host.docker.internal:11434");
  });
});

describe("DELETE /api/settings/providers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSetting).mockResolvedValue(null);
  });

  function makeRequest(body: object) {
    return new Request("http://localhost/api/settings/providers", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("should return 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const response = await DELETE(makeRequest({ provider: "anthropic" }));

    expect(response.status).toBe(401);
  });

  it("should return 403 when non-admin user tries to delete", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "2", email: "user@test.com", role: "member" },
    } as any);

    const response = await DELETE(makeRequest({ provider: "anthropic" }));

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe("Forbidden");
  });

  it("should return 400 for invalid provider name", async () => {
    const response = await DELETE(makeRequest({ provider: "invalid" }));

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Invalid provider");
  });

  it("should return 400 when trying to delete the last configured provider", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-secret";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    const response = await DELETE(makeRequest({ provider: "anthropic" }));

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toMatch(/last configured provider/i);
  });

  it("should delete the provider key and return success", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-secret";
      if (key === "openai_api_key") return "sk-openai-key";
      if (key === "default_provider") return "openai";
      return null;
    });

    const response = await DELETE(makeRequest({ provider: "anthropic" }));

    expect(response.status).toBe(200);
    expect(deleteSetting).toHaveBeenCalledWith("anthropic_api_key");
  });

  it("should switch default_provider when deleting the current default", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-secret";
      if (key === "openai_api_key") return "sk-openai-key";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    const response = await DELETE(makeRequest({ provider: "anthropic" }));

    expect(response.status).toBe(200);
    expect(deleteSetting).toHaveBeenCalledWith("anthropic_api_key");
    expect(setSetting).toHaveBeenCalledWith("default_provider", "openai", false);
  });

  it("should not change default_provider when deleting a non-default provider", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-secret";
      if (key === "openai_api_key") return "sk-openai-key";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    const response = await DELETE(makeRequest({ provider: "openai" }));

    expect(response.status).toBe(200);
    expect(deleteSetting).toHaveBeenCalledWith("openai_api_key");
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("should reset model cache after deleting a provider", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-secret";
      if (key === "openai_api_key") return "sk-openai-key";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    await DELETE(makeRequest({ provider: "openai" }));

    expect(resetCache).toHaveBeenCalled();
  });

  it("should migrate all agents using the removed provider to the new default model", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-secret";
      if (key === "openai_api_key") return "sk-openai-key";
      if (key === "default_provider") return "anthropic";
      return null;
    });
    vi.mocked(db.query.agents.findMany).mockResolvedValueOnce([
      { id: "agent-1", model: "openai/gpt-4o-mini" },
      { id: "agent-2", model: "openai/gpt-4o" },
      { id: "agent-3", model: "anthropic/claude-haiku-4-5-20251001" },
    ] as any[]);

    await DELETE(makeRequest({ provider: "openai" }));

    // Only the 2 openai agents should be migrated, not the anthropic one
    expect(db.update).toHaveBeenCalledTimes(2);
  });

  it("should not migrate agents that use a different provider", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-secret";
      if (key === "openai_api_key") return "sk-openai-key";
      if (key === "default_provider") return "anthropic";
      return null;
    });
    vi.mocked(db.query.agents.findMany).mockResolvedValueOnce([
      { id: "agent-1", model: "anthropic/claude-haiku-4-5-20251001" },
    ] as any[]);

    await DELETE(makeRequest({ provider: "openai" }));

    expect(db.update).not.toHaveBeenCalled();
  });

  it("should call regenerateOpenClawConfig after successful deletion", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-secret";
      if (key === "openai_api_key") return "sk-openai-key";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    await DELETE(makeRequest({ provider: "openai" }));

    expect(regenerateOpenClawConfig).toHaveBeenCalled();
  });

  it("should migrate agents with ollama/ prefix when deleting ollama-local", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "ollama_local_url") return "http://localhost:11434";
      if (key === "anthropic_api_key") return "sk-ant-key";
      if (key === "default_provider") return "ollama-local";
      return null;
    });
    vi.mocked(db.query.agents.findMany).mockResolvedValueOnce([
      { id: "agent-1", model: "ollama/llama3:latest" },
      { id: "agent-2", model: "anthropic/claude-haiku-4-5-20251001" },
    ] as any[]);

    await DELETE(makeRequest({ provider: "ollama-local" }));

    // Only the ollama agent should be migrated, not the anthropic one
    expect(db.update).toHaveBeenCalledTimes(1);
  });
});
