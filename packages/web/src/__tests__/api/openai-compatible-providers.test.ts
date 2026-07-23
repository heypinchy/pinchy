import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST, GET } from "@/app/api/settings/providers/openai-compatible/route";
import { POST as DISCOVER } from "@/app/api/settings/providers/openai-compatible/discover/route";

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

vi.mock("@/lib/openai-compatible-providers", () => ({
  createOrUpdateProvider: vi.fn(),
  listOpenAiCompatibleProviders: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/openai-compatible-discovery", () => ({
  validateOpenAiCompatibleProvider: vi.fn(),
  fetchOpenAiCompatibleModels: vi.fn(),
}));

vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/provider-models", () => ({
  resetCache: vi.fn(),
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit-deferred", () => ({
  recordAuditFailure: vi.fn(),
}));

import { auth } from "@/lib/auth";
import {
  createOrUpdateProvider,
  listOpenAiCompatibleProviders,
} from "@/lib/openai-compatible-providers";
import type { OpenAiCompatibleProviderListItem } from "@/lib/openai-compatible-providers";
import {
  validateOpenAiCompatibleProvider,
  fetchOpenAiCompatibleModels,
} from "@/lib/openai-compatible-discovery";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { resetCache } from "@/lib/provider-models";
import { getSetting, setSetting } from "@/lib/settings";
import { appendAuditLog } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { mockSession } from "@/test-helpers/auth";
import { makeNextRequest } from "@/test-helpers/route";
import type { OpenClawModelDefinition } from "@/lib/openclaw-builtin-models";

const SECRET_KEY = "sk-super-secret-key-9Z8x7";

function modelDef(id: string, name = id): OpenClawModelDefinition {
  return {
    id,
    name,
    contextWindow: 8192,
    maxTokens: 4096,
    reasoning: false,
    vision: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function listItem(
  overrides: Partial<OpenAiCompatibleProviderListItem> = {}
): OpenAiCompatibleProviderListItem {
  return {
    id: "row-id-1",
    slug: "acme-llm",
    displayName: "Acme LLM",
    baseUrl: "https://acme.example.com/v1",
    models: [modelDef("acme-large", "Acme Large")],
    keyHint: "7Z8x",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function postRequest(body: object) {
  return makeNextRequest("http://localhost/api/settings/providers/openai-compatible", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function discoverRequest(body: object) {
  return makeNextRequest("http://localhost/api/settings/providers/openai-compatible/discover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const routeCtx = { params: Promise.resolve({}) };

describe("POST /api/settings/providers/openai-compatible", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(createOrUpdateProvider).mockResolvedValue(listItem());
    vi.mocked(regenerateOpenClawConfig).mockResolvedValue(undefined);
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const res = await POST(
      postRequest({ displayName: "Acme", baseUrl: "https://acme.example.com/v1", models: [] }),
      routeCtx
    );

    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-admin user", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(
      mockSession({ user: { id: "2", role: "member" } })
    );

    const res = await POST(
      postRequest({
        displayName: "Acme",
        baseUrl: "https://acme.example.com/v1",
        apiKey: SECRET_KEY,
        models: [modelDef("acme-large")],
      }),
      routeCtx
    );

    expect(res.status).toBe(403);
    expect(createOrUpdateProvider).not.toHaveBeenCalled();
  });

  it("creates a provider, returns the row, and writes a success audit", async () => {
    vi.mocked(createOrUpdateProvider).mockResolvedValue(listItem({ slug: "acme-llm" }));

    const res = await POST(
      postRequest({
        displayName: "Acme LLM",
        baseUrl: "https://acme.example.com/v1",
        apiKey: SECRET_KEY,
        models: [modelDef("acme-large", "Acme Large")],
      }),
      routeCtx
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.slug).toBe("acme-llm");
    expect(data.keyHint).toBe("7Z8x");

    // The parsed body reached the data-access layer.
    expect(createOrUpdateProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "Acme LLM",
        baseUrl: "https://acme.example.com/v1",
        apiKey: SECRET_KEY,
        models: [expect.objectContaining({ id: "acme-large" })],
      })
    );

    expect(appendAuditLog).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(entry.eventType).toBe("config.changed");
    expect(entry.outcome).toBe("success");
    expect(entry.detail).toMatchObject({
      provider: { id: "acme-llm", name: "Acme LLM" },
      authType: "openai-compatible",
      baseUrlHost: "acme.example.com",
      modelCount: 1,
      runtimeApplied: true,
    });
  });

  it("never leaks the api key or full base url into the audit detail", async () => {
    await POST(
      postRequest({
        displayName: "Acme LLM",
        baseUrl: "https://acme.example.com/v1/private/path",
        apiKey: SECRET_KEY,
        models: [modelDef("acme-large")],
      }),
      routeCtx
    );

    const entry = vi.mocked(appendAuditLog).mock.calls[0][0];
    const serialized = JSON.stringify(entry.detail);
    expect(serialized).not.toContain(SECRET_KEY);
    // Only the host is recorded, never the full path.
    expect(serialized).not.toContain("/v1/private/path");
    expect(serialized).toContain("acme.example.com");
  });

  it("records runtimeApplied: false when regenerate throws (best-effort)", async () => {
    vi.mocked(regenerateOpenClawConfig).mockRejectedValueOnce(new Error("EACCES"));

    const res = await POST(
      postRequest({
        displayName: "Acme LLM",
        baseUrl: "https://acme.example.com/v1",
        apiKey: SECRET_KEY,
        models: [modelDef("acme-large")],
      }),
      routeCtx
    );

    // The row is already persisted — a runtime-apply failure must NOT 500.
    expect(res.status).toBe(200);
    expect(resetCache).toHaveBeenCalled();
    const entry = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(entry.detail).toMatchObject({ runtimeApplied: false });
  });

  it("updates an existing provider without an api key and still succeeds", async () => {
    vi.mocked(createOrUpdateProvider).mockResolvedValue(
      listItem({ slug: "acme-llm", displayName: "Acme Renamed" })
    );

    const res = await POST(
      postRequest({
        id: "11111111-1111-4111-8111-111111111111",
        displayName: "Acme Renamed",
        baseUrl: "https://acme.example.com/v1",
        models: [modelDef("acme-large")],
      }),
      routeCtx
    );

    expect(res.status).toBe(200);
    expect(createOrUpdateProvider).toHaveBeenCalledWith(
      expect.objectContaining({ id: "11111111-1111-4111-8111-111111111111" })
    );
    const entry = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(entry.detail).toMatchObject({
      provider: { id: "acme-llm", name: "Acme Renamed" },
    });
    // No key was supplied — nothing to leak.
    expect(JSON.stringify(entry.detail)).not.toContain(SECRET_KEY);
    // An update must not clobber default_provider wiring for an existing slug.
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("rejects an invalid body (no models) with a structured 400 and no side effects", async () => {
    const res = await POST(
      postRequest({
        displayName: "Acme",
        baseUrl: "https://acme.example.com/v1",
        apiKey: SECRET_KEY,
        models: [],
      }),
      routeCtx
    );

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Validation failed");
    expect(createOrUpdateProvider).not.toHaveBeenCalled();
    expect(appendAuditLog).not.toHaveBeenCalled();
    expect(regenerateOpenClawConfig).not.toHaveBeenCalled();
  });

  it("rejects an invalid body (bad base url) with a structured 400", async () => {
    const res = await POST(
      postRequest({
        displayName: "Acme",
        baseUrl: "not-a-url",
        apiKey: SECRET_KEY,
        models: [modelDef("acme-large")],
      }),
      routeCtx
    );

    expect(res.status).toBe(400);
    expect(createOrUpdateProvider).not.toHaveBeenCalled();
  });

  it("sets default_provider to the new slug when none is configured yet", async () => {
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(createOrUpdateProvider).mockResolvedValue(listItem({ slug: "acme-llm" }));

    await POST(
      postRequest({
        displayName: "Acme LLM",
        baseUrl: "https://acme.example.com/v1",
        apiKey: SECRET_KEY,
        models: [modelDef("acme-large")],
      }),
      routeCtx
    );

    expect(setSetting).toHaveBeenCalledWith("default_provider", "acme-llm", false);
  });

  it("does not overwrite an existing default_provider", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) =>
      key === "default_provider" ? "anthropic" : null
    );
    vi.mocked(createOrUpdateProvider).mockResolvedValue(listItem({ slug: "acme-llm" }));

    await POST(
      postRequest({
        displayName: "Acme LLM",
        baseUrl: "https://acme.example.com/v1",
        apiKey: SECRET_KEY,
        models: [modelDef("acme-large")],
      }),
      routeCtx
    );

    expect(setSetting).not.toHaveBeenCalled();
  });

  it("writes a failure audit and 500 when the data-access layer throws", async () => {
    vi.mocked(createOrUpdateProvider).mockRejectedValueOnce(new Error("db exploded"));

    const res = await POST(
      postRequest({
        displayName: "Acme LLM",
        baseUrl: "https://acme.example.com/v1",
        apiKey: SECRET_KEY,
        models: [modelDef("acme-large")],
      }),
      routeCtx
    );

    expect(res.status).toBe(500);
    expect(appendAuditLog).not.toHaveBeenCalled();
    expect(recordAuditFailure).toHaveBeenCalledTimes(1);
    const [, entry] = vi.mocked(recordAuditFailure).mock.calls[0];
    expect(entry.eventType).toBe("config.changed");
    expect(entry.outcome).toBe("failure");
    // Even the failure audit must not carry the key.
    expect(JSON.stringify(entry.detail)).not.toContain(SECRET_KEY);
  });

  it("never returns the api key in the response body", async () => {
    const res = await POST(
      postRequest({
        displayName: "Acme LLM",
        baseUrl: "https://acme.example.com/v1",
        apiKey: SECRET_KEY,
        models: [modelDef("acme-large")],
      }),
      routeCtx
    );

    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(SECRET_KEY);
  });
});

describe("GET /api/settings/providers/openai-compatible", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 403 for a non-admin user", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(
      mockSession({ user: { id: "2", role: "member" } })
    );

    const res = await GET(makeNextRequest(), routeCtx);
    expect(res.status).toBe(403);
  });

  it("returns the provider list with keyHint and no full key", async () => {
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([
      listItem({ slug: "acme-llm", keyHint: "7Z8x" }),
    ]);

    const res = await GET(makeNextRequest(), routeCtx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data[0].slug).toBe("acme-llm");
    expect(data[0].keyHint).toBe("7Z8x");
    expect(JSON.stringify(data)).not.toContain(SECRET_KEY);
    expect(appendAuditLog).not.toHaveBeenCalled();
  });
});

describe("POST /api/settings/providers/openai-compatible/discover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 403 for a non-admin user", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(
      mockSession({ user: { id: "2", role: "member" } })
    );

    const res = await DISCOVER(
      discoverRequest({ baseUrl: "https://acme.example.com/v1", apiKey: SECRET_KEY }),
      routeCtx
    );
    expect(res.status).toBe(403);
  });

  it("returns discovered models on a valid connection", async () => {
    vi.mocked(validateOpenAiCompatibleProvider).mockResolvedValue({ valid: true });
    vi.mocked(fetchOpenAiCompatibleModels).mockResolvedValue([
      modelDef("acme-large", "Acme Large"),
    ]);

    const res = await DISCOVER(
      discoverRequest({ baseUrl: "https://acme.example.com/v1", apiKey: SECRET_KEY }),
      routeCtx
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.models).toHaveLength(1);
    expect(data.models[0].id).toBe("acme-large");
    expect(data.manualEntry).toBeUndefined();
    // Discovery is a read-only probe.
    expect(appendAuditLog).not.toHaveBeenCalled();
    expect(regenerateOpenClawConfig).not.toHaveBeenCalled();
  });

  it("signals manual entry when the endpoint exposes no models", async () => {
    vi.mocked(validateOpenAiCompatibleProvider).mockResolvedValue({ valid: true });
    vi.mocked(fetchOpenAiCompatibleModels).mockResolvedValue([]);

    const res = await DISCOVER(
      discoverRequest({ baseUrl: "https://acme.example.com/v1", apiKey: SECRET_KEY }),
      routeCtx
    );

    const data = await res.json();
    expect(data).toEqual({ ok: true, models: [], manualEntry: true });
  });

  it("conveys the invalid_key failure variant without fetching models", async () => {
    vi.mocked(validateOpenAiCompatibleProvider).mockResolvedValue({
      valid: false,
      error: "invalid_key",
    });

    const res = await DISCOVER(
      discoverRequest({ baseUrl: "https://acme.example.com/v1", apiKey: SECRET_KEY }),
      routeCtx
    );

    const data = await res.json();
    expect(data).toEqual({ ok: false, error: "invalid_key" });
    expect(fetchOpenAiCompatibleModels).not.toHaveBeenCalled();
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("conveys provider_error and network_error variants", async () => {
    vi.mocked(validateOpenAiCompatibleProvider).mockResolvedValueOnce({
      valid: false,
      error: "provider_error",
      status: 503,
    });
    let res = await DISCOVER(
      discoverRequest({ baseUrl: "https://acme.example.com/v1", apiKey: SECRET_KEY }),
      routeCtx
    );
    expect(await res.json()).toMatchObject({ ok: false, error: "provider_error" });

    vi.mocked(validateOpenAiCompatibleProvider).mockResolvedValueOnce({
      valid: false,
      error: "network_error",
    });
    res = await DISCOVER(
      discoverRequest({ baseUrl: "https://acme.example.com/v1", apiKey: SECRET_KEY }),
      routeCtx
    );
    expect(await res.json()).toMatchObject({ ok: false, error: "network_error" });
  });

  it("rejects an invalid discover body with a structured 400", async () => {
    const res = await DISCOVER(
      discoverRequest({ baseUrl: "not-a-url", apiKey: SECRET_KEY }),
      routeCtx
    );

    expect(res.status).toBe(400);
    expect(validateOpenAiCompatibleProvider).not.toHaveBeenCalled();
  });

  it("never returns the api key in any discover response", async () => {
    vi.mocked(validateOpenAiCompatibleProvider).mockResolvedValue({ valid: true });
    vi.mocked(fetchOpenAiCompatibleModels).mockResolvedValue([modelDef("acme-large")]);

    const res = await DISCOVER(
      discoverRequest({ baseUrl: "https://acme.example.com/v1", apiKey: SECRET_KEY }),
      routeCtx
    );

    expect(JSON.stringify(await res.json())).not.toContain(SECRET_KEY);
  });
});
