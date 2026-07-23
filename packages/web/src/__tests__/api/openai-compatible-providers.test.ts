import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST, GET, DELETE } from "@/app/api/settings/providers/openai-compatible/route";
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
  listOpenAiCompatibleProvidersForAdmin: vi.fn().mockResolvedValue([]),
  deleteProviderById: vi.fn(),
}));

vi.mock("@/lib/provider-count", () => ({
  countConfiguredProviders: vi.fn().mockResolvedValue(2),
  listConfiguredBuiltIns: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/db", () => ({
  db: {
    query: {
      agents: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    },
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    }),
  },
}));

vi.mock("@/lib/model-resolver", () => ({
  resolveModelForTemplate: vi.fn(),
}));

vi.mock("@/lib/personal-agent", () => ({
  SMITHERS_MODEL_HINT: { tier: "balanced", capabilities: ["tools", "long-context"] },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    eq: vi.fn(),
  };
});

vi.mock("@/lib/openai-compatible-discovery", () => ({
  validateOpenAiCompatibleProvider: vi.fn(),
  fetchOpenAiCompatibleModels: vi.fn(),
}));

// SSRF guard is mocked here so route tests stay hermetic (no real DNS) — the
// guard's own IP-classification logic is covered in provider-url-guard.test.ts.
// Default: allow. Blocked cases use mockRejectedValueOnce(new ProviderUrlBlockedError(...)).
// The error class must be the one the route sees, so the factory exports a real class.
vi.mock("@/lib/provider-url-guard", () => {
  class ProviderUrlBlockedError extends Error {
    constructor(
      public readonly reason: string,
      message: string
    ) {
      super(message);
      this.name = "ProviderUrlBlockedError";
    }
  }
  return {
    ProviderUrlBlockedError,
    assertAllowedProviderUrl: vi.fn().mockResolvedValue(undefined),
  };
});

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
  listOpenAiCompatibleProvidersForAdmin,
  deleteProviderById,
} from "@/lib/openai-compatible-providers";
import type { OpenAiCompatibleProviderListItem } from "@/lib/openai-compatible-providers";
import { countConfiguredProviders, listConfiguredBuiltIns } from "@/lib/provider-count";
import { db } from "@/db";
import {
  validateOpenAiCompatibleProvider,
  fetchOpenAiCompatibleModels,
} from "@/lib/openai-compatible-discovery";
import { assertAllowedProviderUrl, ProviderUrlBlockedError } from "@/lib/provider-url-guard";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { resetCache } from "@/lib/provider-models";
import { getSetting, setSetting } from "@/lib/settings";
import { appendAuditLog } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { resolveModelForTemplate } from "@/lib/model-resolver";
import { SMITHERS_MODEL_HINT } from "@/lib/personal-agent";
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

  it("returns 422 with a baseUrl field error when the URL is SSRF-blocked, without persisting", async () => {
    vi.mocked(assertAllowedProviderUrl).mockRejectedValueOnce(
      new ProviderUrlBlockedError("blocked_address", "reserved/internal address")
    );

    const res = await POST(
      postRequest({
        displayName: "Evil",
        baseUrl: "http://169.254.169.254/v1",
        apiKey: SECRET_KEY,
        models: [modelDef("x")],
      }),
      routeCtx
    );

    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.details.fieldErrors.baseUrl?.length).toBeGreaterThan(0);
    // Nothing persisted, no runtime apply.
    expect(createOrUpdateProvider).not.toHaveBeenCalled();
    expect(regenerateOpenClawConfig).not.toHaveBeenCalled();
  });

  it("repoints agents off a model dropped during an update, and audits the migration", async () => {
    vi.mocked(createOrUpdateProvider).mockResolvedValue(
      listItem({ id: "row-1", slug: "acme-llm", models: [modelDef("acme-large", "Acme Large")] })
    );
    const setSpy = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    vi.mocked(db.update).mockReturnValue({ set: setSpy } as any);
    vi.mocked(db.query.agents.findMany).mockResolvedValue([
      { id: "agent-1", name: "Booker", model: "acme-llm/acme-old" }, // dropped → repoint
      { id: "agent-2", name: "Keeper", model: "acme-llm/acme-large" }, // kept → untouched
    ] as any);

    const res = await POST(
      postRequest({
        id: "11111111-1111-4111-8111-111111111111",
        displayName: "Acme LLM",
        baseUrl: "https://acme.example.com/v1",
        models: [modelDef("acme-large", "Acme Large")],
      }),
      routeCtx
    );

    expect(res.status).toBe(200);
    // Exactly one repoint, onto the surviving model.
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith({ model: "acme-llm/acme-large" });
    const entry = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(entry.detail).toMatchObject({ agentCount: 1 });
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

    // Happy-path apply sequence is pinned: config regenerated + model cache reset.
    expect(regenerateOpenClawConfig).toHaveBeenCalled();
    expect(resetCache).toHaveBeenCalled();

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

  it("repoints the seeded Smithers agent to the custom model when it's the first provider (#894)", async () => {
    // Fresh install: no default_provider, and the seeded Smithers agent still
    // points at the unconfigured built-in default. Creating the sole custom
    // provider must repoint it onto the custom instance's resolved model —
    // mirrors the built-in setup route (setup/provider/route.ts).
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(createOrUpdateProvider).mockResolvedValue(listItem({ slug: "acme-llm" }));
    vi.mocked(db.query.agents.findFirst).mockResolvedValue({
      id: "agent-smithers",
      name: "Smithers",
      model: "anthropic/claude-sonnet-4-6",
    } as any);
    vi.mocked(resolveModelForTemplate).mockResolvedValue({
      model: "acme-llm/acme-large",
      reason: "custom",
      fallbackUsed: false,
    });

    const setSpy = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    vi.mocked(db.update).mockReturnValue({ set: setSpy } as any);

    await POST(
      postRequest({
        displayName: "Acme LLM",
        baseUrl: "https://acme.example.com/v1",
        apiKey: SECRET_KEY,
        models: [modelDef("acme-large")],
      }),
      routeCtx
    );

    // The resolver is asked for the SEEDED agent's hint against the NEW slug.
    expect(resolveModelForTemplate).toHaveBeenCalledWith({
      hint: SMITHERS_MODEL_HINT,
      provider: "acme-llm",
    });
    // ...and the seeded agent is repointed onto the resolved custom model.
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith({ model: "acme-llm/acme-large" });
    expect(setSetting).toHaveBeenCalledWith("default_provider", "acme-llm", false);
  });

  it("does NOT repoint any agent when a default_provider already exists (#894)", async () => {
    // An existing default means this isn't the first provider — never clobber
    // the seeded agent's model on a subsequent create.
    vi.mocked(getSetting).mockImplementation(async (key: string) =>
      key === "default_provider" ? "anthropic" : null
    );
    vi.mocked(createOrUpdateProvider).mockResolvedValue(listItem({ slug: "acme-llm" }));
    vi.mocked(db.query.agents.findFirst).mockResolvedValue({
      id: "agent-smithers",
      name: "Smithers",
      model: "anthropic/claude-sonnet-4-6",
    } as any);

    await POST(
      postRequest({
        displayName: "Acme LLM",
        baseUrl: "https://acme.example.com/v1",
        apiKey: SECRET_KEY,
        models: [modelDef("acme-large")],
      }),
      routeCtx
    );

    expect(resolveModelForTemplate).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("writes a failure audit and 500 when a CREATE throws (no id to correlate)", async () => {
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
    // On a create the slug isn't derivable yet — the detail carries the display
    // name only, with NO provider id.
    expect(entry.detail).toMatchObject({ provider: { name: "Acme LLM" } });
    expect((entry.detail as { provider: { id?: string } }).provider.id).toBeUndefined();
    // Even the failure audit must not carry the key.
    expect(JSON.stringify(entry.detail)).not.toContain(SECRET_KEY);
  });

  it("correlates an UPDATE failure by input.id in the failure audit", async () => {
    const updateId = "22222222-2222-4222-8222-222222222222";
    vi.mocked(createOrUpdateProvider).mockRejectedValueOnce(new Error("db exploded"));

    const res = await POST(
      postRequest({
        id: updateId,
        displayName: "Acme Renamed",
        baseUrl: "https://acme.example.com/v1",
        // No apiKey on an update — nothing to leak.
        models: [modelDef("acme-large")],
      }),
      routeCtx
    );

    expect(res.status).toBe(500);
    expect(appendAuditLog).not.toHaveBeenCalled();
    expect(recordAuditFailure).toHaveBeenCalledTimes(1);
    const [, entry] = vi.mocked(recordAuditFailure).mock.calls[0];
    expect(entry.outcome).toBe("failure");
    // input.id is in hand on an update — it's the only correlation key an
    // analyst has for which row failed to save.
    expect(entry.detail).toMatchObject({
      provider: { id: updateId, name: "Acme Renamed" },
    });
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
    vi.mocked(listOpenAiCompatibleProvidersForAdmin).mockResolvedValue([
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

  it("returns blocked_url and never probes when the URL is SSRF-blocked", async () => {
    vi.mocked(assertAllowedProviderUrl).mockRejectedValueOnce(
      new ProviderUrlBlockedError("blocked_address", "reserved/internal address")
    );

    const res = await DISCOVER(
      discoverRequest({ baseUrl: "http://169.254.169.254/v1", apiKey: SECRET_KEY }),
      routeCtx
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ ok: false, error: "blocked_url" });
    // The probe must NOT have gone out.
    expect(validateOpenAiCompatibleProvider).not.toHaveBeenCalled();
    expect(fetchOpenAiCompatibleModels).not.toHaveBeenCalled();
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

describe("DELETE /api/settings/providers/openai-compatible", () => {
  const PROVIDER_ID = "33333333-3333-4333-8333-333333333333";

  function deleteRequest(body: object) {
    return makeNextRequest("http://localhost/api/settings/providers/openai-compatible", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(countConfiguredProviders).mockResolvedValue(2);
    vi.mocked(listConfiguredBuiltIns).mockResolvedValue([]);
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([]);
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(regenerateOpenClawConfig).mockResolvedValue(undefined);
    vi.mocked(db.query.agents.findMany).mockResolvedValue([]);
    vi.mocked(deleteProviderById).mockResolvedValue({
      id: PROVIDER_ID,
      slug: "acme-llm",
      displayName: "Acme LLM",
    });
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const res = await DELETE(deleteRequest({ id: PROVIDER_ID }), routeCtx);

    expect(res.status).toBe(401);
    expect(deleteProviderById).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-admin user", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(
      mockSession({ user: { id: "2", role: "member" } })
    );

    const res = await DELETE(deleteRequest({ id: PROVIDER_ID }), routeCtx);

    expect(res.status).toBe(403);
    expect(deleteProviderById).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid id with a structured 400 and no side effects", async () => {
    const res = await DELETE(deleteRequest({ id: "not-a-uuid" }), routeCtx);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Validation failed");
    expect(deleteProviderById).not.toHaveBeenCalled();
  });

  it("refuses to delete the sole remaining provider", async () => {
    vi.mocked(countConfiguredProviders).mockResolvedValue(1);

    const res = await DELETE(deleteRequest({ id: PROVIDER_ID }), routeCtx);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/last configured provider/i);
    // The guard fires before any destructive work.
    expect(deleteProviderById).not.toHaveBeenCalled();
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 404 when the id does not match a provider (no migration, no success audit)", async () => {
    vi.mocked(deleteProviderById).mockResolvedValue(null);

    const res = await DELETE(deleteRequest({ id: PROVIDER_ID }), routeCtx);

    expect(res.status).toBe(404);
    expect(db.update).not.toHaveBeenCalled();
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("deletes a custom instance, migrates its agents, and writes a success audit", async () => {
    vi.mocked(listConfiguredBuiltIns).mockResolvedValue([
      {
        name: "anthropic",
        config: { defaultModel: "anthropic/claude-haiku-4-5-20251001" },
      },
    ] as any);
    // default_provider points elsewhere — no reassignment expected.
    vi.mocked(getSetting).mockImplementation(async (key: string) =>
      key === "default_provider" ? "anthropic" : null
    );
    vi.mocked(db.query.agents.findMany).mockResolvedValue([
      { id: "agent-1", name: "Booker", model: "acme-llm/acme-large" },
      { id: "agent-2", name: "Reader", model: "anthropic/claude-haiku-4-5-20251001" },
    ] as any);

    const setSpy = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    vi.mocked(db.update).mockReturnValue({ set: setSpy } as any);

    const res = await DELETE(deleteRequest({ id: PROVIDER_ID }), routeCtx);

    expect(res.status).toBe(200);
    expect(deleteProviderById).toHaveBeenCalledWith(PROVIDER_ID);

    // Only the agent on the deleted slug migrates — onto the remaining built-in's
    // default model, not the untouched anthropic agent.
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith({ model: "anthropic/claude-haiku-4-5-20251001" });

    const data = await res.json();
    expect(data).toMatchObject({ ok: true, migratedAgents: 1 });

    expect(appendAuditLog).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(entry.eventType).toBe("settings.deleted");
    expect(entry.resource).toBe("settings:provider:acme-llm");
    expect(entry.outcome).toBe("success");
    expect(entry.detail).toMatchObject({
      provider: { id: PROVIDER_ID, name: "Acme LLM" },
      slug: "acme-llm",
      agentCount: 1,
      migratedAgents: [
        {
          id: "agent-1",
          name: "Booker",
          fromModel: "acme-llm/acme-large",
          toModel: "anthropic/claude-haiku-4-5-20251001",
        },
      ],
      runtimeApplied: true,
    });
    // The deleted provider's display name survives for post-deletion analysis,
    // and nothing key- or PII-shaped leaks into the detail.
    expect(JSON.stringify(entry.detail)).not.toContain(SECRET_KEY);
  });

  it("reassigns default_provider when the deleted slug was the default", async () => {
    vi.mocked(listConfiguredBuiltIns).mockResolvedValue([
      {
        name: "anthropic",
        config: { defaultModel: "anthropic/claude-haiku-4-5-20251001" },
      },
    ] as any);
    vi.mocked(getSetting).mockImplementation(async (key: string) =>
      key === "default_provider" ? "acme-llm" : null
    );

    const res = await DELETE(deleteRequest({ id: PROVIDER_ID }), routeCtx);

    expect(res.status).toBe(200);
    // Reassigned to the first remaining candidate (the built-in).
    expect(setSetting).toHaveBeenCalledWith("default_provider", "anthropic", false);
    const data = await res.json();
    expect(data).toMatchObject({ ok: true, newDefault: "anthropic" });
    const entry = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(entry.detail).toMatchObject({ wasDefault: true, newDefault: "anthropic" });
  });

  it("migrates onto another custom instance when no built-in remains", async () => {
    vi.mocked(listConfiguredBuiltIns).mockResolvedValue([]);
    // The remaining custom instance (the deleted one is already gone from this list).
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([
      listItem({ slug: "other-llm", models: [modelDef("other-large")] }),
    ]);
    vi.mocked(getSetting).mockImplementation(async (key: string) =>
      key === "default_provider" ? "acme-llm" : null
    );
    vi.mocked(db.query.agents.findMany).mockResolvedValue([
      { id: "agent-1", name: "Booker", model: "acme-llm/acme-large" },
    ] as any);

    const setSpy = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    vi.mocked(db.update).mockReturnValue({ set: setSpy } as any);

    const res = await DELETE(deleteRequest({ id: PROVIDER_ID }), routeCtx);

    expect(res.status).toBe(200);
    expect(setSpy).toHaveBeenCalledWith({ model: "other-llm/other-large" });
    expect(setSetting).toHaveBeenCalledWith("default_provider", "other-llm", false);
  });

  it("writes a failure audit and 500 when migration throws mid-flight", async () => {
    vi.mocked(listConfiguredBuiltIns).mockResolvedValue([
      {
        name: "anthropic",
        config: { defaultModel: "anthropic/claude-haiku-4-5-20251001" },
      },
    ] as any);
    vi.mocked(getSetting).mockImplementation(async (key: string) =>
      key === "default_provider" ? "acme-llm" : null
    );
    // The row is deleted, then the agent scan explodes partway through migration.
    vi.mocked(db.query.agents.findMany).mockRejectedValueOnce(new Error("db exploded"));

    const res = await DELETE(deleteRequest({ id: PROVIDER_ID }), routeCtx);

    expect(res.status).toBe(500);
    // No success audit on the failure path.
    expect(appendAuditLog).not.toHaveBeenCalled();
    expect(recordAuditFailure).toHaveBeenCalledTimes(1);
    const [, entry] = vi.mocked(recordAuditFailure).mock.calls[0];
    expect(entry.eventType).toBe("settings.deleted");
    expect(entry.outcome).toBe("failure");
    expect(entry.resource).toBe("settings:provider:acme-llm");
    // The deleted row's identity is snapshotted for post-mortem correlation.
    expect(entry.detail).toMatchObject({
      name: "Acme LLM",
      provider: { id: PROVIDER_ID, name: "Acme LLM" },
      slug: "acme-llm",
    });
    expect(JSON.stringify(entry.detail)).not.toContain(SECRET_KEY);
  });

  it("still succeeds with runtimeApplied:false when regenerate throws (best-effort)", async () => {
    vi.mocked(regenerateOpenClawConfig).mockRejectedValueOnce(new Error("EACCES"));

    const res = await DELETE(deleteRequest({ id: PROVIDER_ID }), routeCtx);

    expect(res.status).toBe(200);
    expect(resetCache).toHaveBeenCalled();
    const entry = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(entry.detail).toMatchObject({ runtimeApplied: false });
  });
});
