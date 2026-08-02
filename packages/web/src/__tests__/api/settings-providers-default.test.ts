import { describe, it, expect, vi, beforeEach } from "vitest";
import { PATCH } from "@/app/api/settings/providers/default/route";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => {
  const mockGetSession = vi.fn().mockResolvedValue({
    user: { id: "1", email: "admin@test.com", role: "admin" },
  });
  return {
    getSession: mockGetSession,
    auth: { api: { getSession: mockGetSession } },
  };
});

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/openai-compatible-providers", () => ({
  listOpenAiCompatibleProviders: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/provider-models", () => ({
  resetCache: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import { auth } from "@/lib/auth";
import { getSetting, setSetting } from "@/lib/settings";
import { listOpenAiCompatibleProviders } from "@/lib/openai-compatible-providers";
import type { OpenAiCompatibleProvider } from "@/lib/openai-compatible-providers";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { resetCache } from "@/lib/provider-models";
import { appendAuditLog } from "@/lib/audit";
import { mockSession } from "@/test-helpers/auth";
import { makeNextRequest, routeContext } from "@/test-helpers/route";

function customProvider(
  overrides: Partial<OpenAiCompatibleProvider> = {}
): OpenAiCompatibleProvider {
  return {
    id: "row-id-1",
    slug: "acme-llm",
    displayName: "Acme LLM",
    baseUrl: "https://acme.example.com/v1",
    models: [],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function patchRequest(body: object) {
  return makeNextRequest("http://localhost/api/settings/providers/default", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/settings/providers/default", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([]);
    vi.mocked(regenerateOpenClawConfig).mockResolvedValue(undefined);
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const res = await PATCH(patchRequest({ provider: "anthropic" }), routeContext());

    expect(res.status).toBe(401);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-admin user", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(
      mockSession({ user: { id: "2", role: "member" } })
    );

    const res = await PATCH(patchRequest({ provider: "anthropic" }), routeContext());

    expect(res.status).toBe(403);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("rejects an empty provider with a structured 400", async () => {
    const res = await PATCH(patchRequest({ provider: "" }), routeContext());

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Validation failed");
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("rejects a built-in name that isn't configured (400)", async () => {
    vi.mocked(getSetting).mockResolvedValue(null);

    const res = await PATCH(patchRequest({ provider: "anthropic" }), routeContext());

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/isn't configured/i);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("rejects an unknown slug that matches neither a built-in nor a custom provider (404)", async () => {
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([]);

    const res = await PATCH(patchRequest({ provider: "no-such-provider" }), routeContext());

    expect(res.status).toBe(404);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("sets a configured built-in as the default and writes a config.changed audit", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-secret";
      if (key === "default_provider") return "openai";
      return null;
    });

    const res = await PATCH(patchRequest({ provider: "anthropic" }), routeContext());

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ success: true, defaultProvider: "anthropic" });
    expect(setSetting).toHaveBeenCalledWith("default_provider", "anthropic", false);
    expect(regenerateOpenClawConfig).toHaveBeenCalled();
    expect(resetCache).toHaveBeenCalled();

    expect(appendAuditLog).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(entry.eventType).toBe("config.changed");
    expect(entry.outcome).toBe("success");
    expect(entry.detail).toMatchObject({
      provider: { id: "anthropic", name: "Anthropic" },
      previousDefault: "openai",
      newDefault: "anthropic",
      configRegenerated: true,
    });
  });

  it("sets an existing custom slug as the default", async () => {
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([
      customProvider({ slug: "acme-llm", displayName: "Acme LLM" }),
    ]);
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "default_provider") return "anthropic";
      return null;
    });

    const res = await PATCH(patchRequest({ provider: "acme-llm" }), routeContext());

    expect(res.status).toBe(200);
    expect(setSetting).toHaveBeenCalledWith("default_provider", "acme-llm", false);
    const entry = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(entry.detail).toMatchObject({
      provider: { id: "acme-llm", name: "Acme LLM" },
      previousDefault: "anthropic",
      newDefault: "acme-llm",
    });
  });

  it("returns success with a warning (not a 500) when regenerate throws (#880 pattern)", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-secret";
      return null;
    });
    vi.mocked(regenerateOpenClawConfig).mockRejectedValueOnce(new Error("EACCES"));

    const res = await PATCH(patchRequest({ provider: "anthropic" }), routeContext());

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.warning).toMatch(/agent runtime failed/i);
    expect(setSetting).toHaveBeenCalledWith("default_provider", "anthropic", false);
    expect(resetCache).toHaveBeenCalled();
    const entry = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(entry.detail).toMatchObject({ configRegenerated: false });
  });

  it("never writes an audit entry on a rejected request", async () => {
    const res = await PATCH(patchRequest({ provider: "anthropic" }), routeContext());

    expect(res.status).toBe(400);
    expect(appendAuditLog).not.toHaveBeenCalled();
  });
});
