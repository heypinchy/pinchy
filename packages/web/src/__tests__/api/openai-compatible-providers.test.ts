import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST, GET, DELETE } from "@/app/api/settings/providers/openai-compatible/route";
import { POST as DISCOVER } from "@/app/api/settings/providers/openai-compatible/discover/route";
import { GET as PREVIEW } from "@/app/api/settings/providers/deletion-preview/route";

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

// The route tells a lost compare-and-swap apart from any other persist failure
// by `instanceof`, so the factory exports a real class (same pattern as the
// provider-url-guard mock below).
vi.mock("@/lib/openai-compatible-providers", () => {
  class ProviderChangedError extends Error {
    constructor(id: string) {
      super(`OpenAI-compatible provider changed while saving: ${id}`);
      this.name = "ProviderChangedError";
    }
  }
  class ProviderNotFoundError extends Error {
    constructor(id: string) {
      super(`OpenAI-compatible provider not found: ${id}`);
      this.name = "ProviderNotFoundError";
    }
  }
  return {
    ProviderChangedError,
    ProviderNotFoundError,
    createOrUpdateProvider: vi.fn(),
    listOpenAiCompatibleProviders: vi.fn().mockResolvedValue([]),
    listOpenAiCompatibleProvidersForAdmin: vi.fn().mockResolvedValue([]),
    deleteProviderById: vi.fn(),
    getProviderSnapshotById: vi.fn(),
    decryptStoredKey: vi.fn().mockReturnValue("sk-stored-key"),
    getModelsById: vi.fn().mockResolvedValue([]),
  };
});

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
    // The GET list asks once per host per request; with the guard mocked the
    // resolver is never called.
    memoizeResolver: vi.fn(() => vi.fn()),
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
  getProviderSnapshotById,
  decryptStoredKey,
  getModelsById,
  ProviderChangedError,
  ProviderNotFoundError,
} from "@/lib/openai-compatible-providers";
import type { StoredProviderSnapshot } from "@/lib/openai-compatible-providers";
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
import {
  LAST_USABLE_PROVIDER_ERROR,
  NO_USABLE_TARGET_FOR_REFUSED_PROVIDER_ERROR,
} from "@/lib/provider-deletion";

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

/** The stored row an update is checked against: one read, all four fields. */
function storedSnapshot(overrides: Partial<StoredProviderSnapshot> = {}): StoredProviderSnapshot {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "acme-llm",
    displayName: "Acme LLM",
    baseUrl: "https://acme.example.com/v1",
    encryptedApiKey: "ciphertext-of-the-stored-key",
    ...overrides,
  };
}

describe("POST /api/settings/providers/openai-compatible", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(createOrUpdateProvider).mockResolvedValue(listItem());
    vi.mocked(regenerateOpenClawConfig).mockResolvedValue(undefined);
    vi.mocked(decryptStoredKey).mockReturnValue("sk-stored-key");
    vi.mocked(getProviderSnapshotById).mockResolvedValue(storedSnapshot());
    // Default: server-side discovery finds one model. #894 backend redesign —
    // the client no longer sends `models`; the route calls
    // fetchOpenAiCompatibleModels itself, mocked here.
    vi.mocked(fetchOpenAiCompatibleModels).mockResolvedValue([
      modelDef("acme-large", "Acme Large"),
    ]);
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const res = await POST(
      postRequest({ displayName: "Acme", baseUrl: "https://acme.example.com/v1" }),
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
      }),
      routeCtx
    );

    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.details.fieldErrors.baseUrl?.length).toBeGreaterThan(0);
    // Nothing persisted, no runtime apply, and discovery never even ran.
    expect(fetchOpenAiCompatibleModels).not.toHaveBeenCalled();
    expect(createOrUpdateProvider).not.toHaveBeenCalled();
    expect(regenerateOpenClawConfig).not.toHaveBeenCalled();
  });

  it("returns 422 with a manualModelIds field error when discovery finds nothing and no fallback is given", async () => {
    vi.mocked(fetchOpenAiCompatibleModels).mockResolvedValue([]);

    const res = await POST(
      postRequest({
        displayName: "Acme LLM",
        baseUrl: "https://acme.example.com/v1",
        apiKey: SECRET_KEY,
      }),
      routeCtx
    );

    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.details.fieldErrors.manualModelIds?.length).toBeGreaterThan(0);
    expect(createOrUpdateProvider).not.toHaveBeenCalled();
    expect(regenerateOpenClawConfig).not.toHaveBeenCalled();
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("falls back to manualModelIds, resolved via the model catalog, when discovery finds nothing", async () => {
    vi.mocked(fetchOpenAiCompatibleModels).mockResolvedValue([]);
    vi.mocked(createOrUpdateProvider).mockResolvedValue(
      listItem({ slug: "acme-llm", models: [modelDef("hand-entered-id", "hand-entered-id")] })
    );

    const res = await POST(
      postRequest({
        displayName: "Acme LLM",
        baseUrl: "https://acme.example.com/v1",
        apiKey: SECRET_KEY,
        manualModelIds: ["hand-entered-id"],
      }),
      routeCtx
    );

    expect(res.status).toBe(200);
    // Manual ids resolve to DEFAULT_MODEL_CAPS-shaped defs (unknown to the
    // catalog) and are what gets persisted as the snapshot.
    expect(createOrUpdateProvider).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Acme LLM" }),
      [expect.objectContaining({ id: "hand-entered-id", name: "hand-entered-id" })]
    );
  });

  it("keeps the existing model snapshot on update when live discovery finds nothing", async () => {
    // Endpoint is transiently down (or between an update and a re-list): discovery
    // returns nothing. An UPDATE must NOT 422 or blank the models — it keeps the
    // stored snapshot so a rename during an outage still saves.
    vi.mocked(fetchOpenAiCompatibleModels).mockResolvedValue([]);
    const existing = [modelDef("acme-large", "Acme Large")];
    vi.mocked(getModelsById).mockResolvedValue(existing);
    vi.mocked(createOrUpdateProvider).mockResolvedValue(
      listItem({ id: "row-1", slug: "acme-llm", models: existing })
    );

    const res = await POST(
      postRequest({
        id: "11111111-1111-4111-8111-111111111111",
        displayName: "Acme LLM Renamed",
        baseUrl: "https://acme.example.com/v1",
      }),
      routeCtx
    );

    expect(res.status).toBe(200);
    expect(getModelsById).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    // The preserved snapshot is what gets persisted — not an empty list.
    expect(createOrUpdateProvider).toHaveBeenCalledWith(
      expect.objectContaining({ id: "11111111-1111-4111-8111-111111111111" }),
      existing,
      storedSnapshot()
    );
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

    // Discovery ran against the submitted baseUrl/apiKey, and its result (not
    // a client-supplied list) reached the data-access layer as the explicit
    // second argument.
    expect(fetchOpenAiCompatibleModels).toHaveBeenCalledWith(
      "https://acme.example.com/v1",
      SECRET_KEY
    );
    expect(createOrUpdateProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "Acme LLM",
        baseUrl: "https://acme.example.com/v1",
        apiKey: SECRET_KEY,
      }),
      [expect.objectContaining({ id: "acme-large" })]
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
      configRegenerated: true,
    });
  });

  it("never leaks the api key or full base url into the audit detail", async () => {
    await POST(
      postRequest({
        displayName: "Acme LLM",
        baseUrl: "https://acme.example.com/v1/private/path",
        apiKey: SECRET_KEY,
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

  it("records configRegenerated: false when regenerate throws (best-effort)", async () => {
    vi.mocked(regenerateOpenClawConfig).mockRejectedValueOnce(new Error("EACCES"));

    const res = await POST(
      postRequest({
        displayName: "Acme LLM",
        baseUrl: "https://acme.example.com/v1",
        apiKey: SECRET_KEY,
      }),
      routeCtx
    );

    // The row is already persisted — a runtime-apply failure must NOT 500.
    expect(res.status).toBe(200);
    expect(resetCache).toHaveBeenCalled();
    const entry = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(entry.detail).toMatchObject({ configRegenerated: false });
  });

  it("updates an existing provider without an api key and still succeeds, discovering with the STORED key", async () => {
    vi.mocked(createOrUpdateProvider).mockResolvedValue(
      listItem({ slug: "acme-llm", displayName: "Acme Renamed" })
    );

    const res = await POST(
      postRequest({
        id: "11111111-1111-4111-8111-111111111111",
        displayName: "Acme Renamed",
        baseUrl: "https://acme.example.com/v1",
      }),
      routeCtx
    );

    expect(res.status).toBe(200);
    // No apiKey in the body ⇒ the route falls back to the stored, decrypted key.
    expect(getProviderSnapshotById).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(decryptStoredKey).toHaveBeenCalledWith(storedSnapshot());
    expect(fetchOpenAiCompatibleModels).toHaveBeenCalledWith(
      "https://acme.example.com/v1",
      "sk-stored-key"
    );
    expect(createOrUpdateProvider).toHaveBeenCalledWith(
      expect.objectContaining({ id: "11111111-1111-4111-8111-111111111111" }),
      expect.any(Array),
      storedSnapshot()
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

  describe("a stored key never follows the base URL to a new address", () => {
    const updateId = "11111111-1111-4111-8111-111111111111";

    it("rejects an update that moves the base URL to a new host without an api key, before any request", async () => {
      const res = await POST(
        postRequest({
          id: updateId,
          displayName: "Acme LLM",
          baseUrl: "https://attacker.example.net/v1",
        }),
        routeCtx
      );

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.details.fieldErrors.apiKey).toEqual([
        "Enter the API key again when you change the address — the stored key is never sent to a new address.",
      ]);
      // The stored key is never even decrypted, let alone sent anywhere.
      expect(decryptStoredKey).not.toHaveBeenCalled();
      expect(fetchOpenAiCompatibleModels).not.toHaveBeenCalled();
      expect(createOrUpdateProvider).not.toHaveBeenCalled();
      expect(regenerateOpenClawConfig).not.toHaveBeenCalled();
    });

    it.each([
      ["scheme", "http://acme.example.com/v1"],
      ["port", "https://acme.example.com:8443/v1"],
      ["host", "https://acme.example.org/v1"],
    ])("treats a changed %s as a new address", async (_what, baseUrl) => {
      const res = await POST(
        postRequest({ id: updateId, displayName: "Acme LLM", baseUrl }),
        routeCtx
      );

      expect(res.status).toBe(422);
      expect(fetchOpenAiCompatibleModels).not.toHaveBeenCalled();
      expect(createOrUpdateProvider).not.toHaveBeenCalled();
    });

    it("lets a fresh api key accompany a new origin, and discovers with the NEW key only", async () => {
      const res = await POST(
        postRequest({
          id: updateId,
          displayName: "Acme LLM",
          baseUrl: "https://new-host.example.com/v1",
          apiKey: "sk-fresh-key",
        }),
        routeCtx
      );

      expect(res.status).toBe(200);
      expect(decryptStoredKey).not.toHaveBeenCalled();
      expect(fetchOpenAiCompatibleModels).toHaveBeenCalledTimes(1);
      expect(fetchOpenAiCompatibleModels).toHaveBeenCalledWith(
        "https://new-host.example.com/v1",
        "sk-fresh-key"
      );
    });

    // Corrected expectation, not a weakened one: this test used to assert that a
    // path-only change on the same origin REUSED the stored key. That is the
    // same leak one level down — a shared gateway origin routes by path (a
    // Cloudflare AI Gateway URL `/v1/<account>/<gateway>` sends the key into
    // whichever account it names), so the key is bound to the full base URL.
    it("refuses a path-only change without a fresh key: a shared origin routes by path", async () => {
      vi.mocked(getProviderSnapshotById).mockResolvedValue(
        storedSnapshot({ baseUrl: "https://gateway.ai.cloudflare.com/v1/acct-a/gw" })
      );
      const res = await POST(
        postRequest({
          id: updateId,
          displayName: "Acme LLM",
          baseUrl: "https://gateway.ai.cloudflare.com/v1/acct-b/gw",
        }),
        routeCtx
      );

      expect(res.status).toBe(422);
      expect(decryptStoredKey).not.toHaveBeenCalled();
      expect(fetchOpenAiCompatibleModels).not.toHaveBeenCalled();
      expect(createOrUpdateProvider).not.toHaveBeenCalled();
    });

    it("still reuses the stored key when only a trailing slash or the host's letter case differs", async () => {
      const res = await POST(
        postRequest({
          id: updateId,
          displayName: "Acme LLM",
          baseUrl: "https://ACME.example.com/v1/",
        }),
        routeCtx
      );

      expect(res.status).toBe(200);
      expect(fetchOpenAiCompatibleModels).toHaveBeenCalledWith(
        "https://ACME.example.com/v1/",
        "sk-stored-key"
      );
    });

    it("audits a refused update as a config.changed failure, naming the provider and both URLs", async () => {
      const res = await POST(
        postRequest({
          id: updateId,
          displayName: "Acme LLM",
          baseUrl: "https://attacker.example.net/v1?key=leaky",
        }),
        routeCtx
      );

      expect(res.status).toBe(422);
      expect(appendAuditLog).toHaveBeenCalledTimes(1);
      const entry = vi.mocked(appendAuditLog).mock.calls[0][0];
      expect(entry).toMatchObject({
        eventType: "config.changed",
        outcome: "failure",
        detail: {
          // The same identity the success row uses (the slug), so one filter
          // finds a provider's whole history.
          provider: { id: "acme-llm", name: "Acme LLM" },
          authType: "openai-compatible",
          reason: "secret_required_for_new_destination",
          baseUrlChange: {
            from: "https://acme.example.com/v1",
            to: "https://attacker.example.net/v1",
          },
        },
      });
      expect(entry.error?.message).toBeTruthy();
      // The query can carry a credential, so it never reaches the audit row.
      expect(JSON.stringify(entry)).not.toContain("leaky");
      expect(JSON.stringify(entry)).not.toContain("sk-stored-key");
    });

    it("names a refused provider by its STORED name, never the one in the request", async () => {
      await POST(
        postRequest({
          id: updateId,
          displayName: "Totally Legit Provider",
          baseUrl: "https://attacker.example.net/v1",
        }),
        routeCtx
      );

      const entry = vi.mocked(appendAuditLog).mock.calls[0][0];
      expect(entry.detail).toMatchObject({ provider: { id: "acme-llm", name: "Acme LLM" } });
      expect(JSON.stringify(entry.detail)).not.toContain("Totally Legit Provider");
    });

    it("caps each audited URL so a 3 KB path cannot push reason and baseUrlChange into a truncation summary", async () => {
      const { truncateDetail } = await vi.importActual<typeof import("@/lib/audit")>("@/lib/audit");
      // A stored row from before the schema bounded URLs, and a submitted URL
      // just inside today's bound: together they would blow the 2 KB budget.
      vi.mocked(getProviderSnapshotById).mockResolvedValue(
        storedSnapshot({ baseUrl: `https://acme.example.com/${"a".repeat(3000)}` })
      );
      const res = await POST(
        postRequest({
          id: updateId,
          displayName: "Acme LLM",
          baseUrl: `https://attacker.example.net/${"b".repeat(1900)}`,
        }),
        routeCtx
      );

      expect(res.status).toBe(422);
      const stored = truncateDetail(vi.mocked(appendAuditLog).mock.calls[0][0].detail);
      expect(stored).not.toHaveProperty("_truncated");
      expect(stored).toMatchObject({ reason: "secret_required_for_new_destination" });
      const change = (stored as { baseUrlChange: { from: string; to: string } }).baseUrlChange;
      expect(change.from.startsWith("https://acme.example.com/aaa")).toBe(true);
      expect(change.to.startsWith("https://attacker.example.net/bbb")).toBe(true);
      for (const value of [change.from, change.to]) {
        expect(new TextEncoder().encode(value).length).toBeLessThanOrEqual(256);
        expect(value.endsWith("…")).toBe(true);
      }
    });

    it("rejects a base URL longer than 2048 characters with an inline field error", async () => {
      const res = await POST(
        postRequest({
          id: updateId,
          displayName: "Acme LLM",
          baseUrl: `https://acme.example.com/${"a".repeat(2100)}`,
          apiKey: SECRET_KEY,
        }),
        routeCtx
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.details.fieldErrors.baseUrl).toBeDefined();
      expect(fetchOpenAiCompatibleModels).not.toHaveBeenCalled();
      expect(createOrUpdateProvider).not.toHaveBeenCalled();
    });

    it("records the base URL change on the success audit, without any key", async () => {
      const res = await POST(
        postRequest({
          id: updateId,
          displayName: "Acme LLM",
          baseUrl: "https://new-host.example.com:8443/v1",
          apiKey: SECRET_KEY,
        }),
        routeCtx
      );

      expect(res.status).toBe(200);
      const entry = vi.mocked(appendAuditLog).mock.calls[0][0];
      expect(entry.detail).toMatchObject({
        baseUrlHost: "new-host.example.com:8443",
        baseUrlChange: {
          from: "https://acme.example.com/v1",
          to: "https://new-host.example.com:8443/v1",
        },
      });
      expect(JSON.stringify(entry.detail)).not.toContain(SECRET_KEY);
      expect(JSON.stringify(entry.detail).length).toBeLessThan(2048);
    });

    it("returns 404 when the provider to update does not exist, without probing anything", async () => {
      vi.mocked(getProviderSnapshotById).mockResolvedValue(undefined);

      const res = await POST(
        postRequest({ id: updateId, displayName: "Ghost", baseUrl: "https://acme.example.com/v1" }),
        routeCtx
      );

      expect(res.status).toBe(404);
      expect(fetchOpenAiCompatibleModels).not.toHaveBeenCalled();
      expect(createOrUpdateProvider).not.toHaveBeenCalled();
    });

    it("does not record a base URL change when the base URL is unchanged", async () => {
      await POST(
        postRequest({
          id: updateId,
          displayName: "Acme Renamed",
          baseUrl: "https://acme.example.com/v1",
        }),
        routeCtx
      );

      const entry = vi.mocked(appendAuditLog).mock.calls[0][0];
      expect(entry.detail).not.toHaveProperty("baseUrlChange");
    });
  });

  // Review finding on #1238: the destination check, the discovery request (up to
  // ~10s against a host the caller may control) and the write used to be three
  // independent steps. A keyless save held open that long could land after an
  // admin had re-entered the real key, pairing the caller's URL with that key.
  // The write is now conditional on the row still holding the base URL AND the
  // key ciphertext the check saw; the DB half is pinned in
  // openai-compatible-providers.integration.test.ts and
  // openai-compatible-provider-race.integration.test.ts.
  describe("a save only lands on the row it was checked against", () => {
    const updateId = "11111111-1111-4111-8111-111111111111";

    it("reads base URL and key in one snapshot and hands that snapshot to the write as its condition", async () => {
      await POST(
        postRequest({
          id: updateId,
          displayName: "Acme LLM",
          baseUrl: "https://acme.example.com/v1",
        }),
        routeCtx
      );

      expect(getProviderSnapshotById).toHaveBeenCalledTimes(1);
      expect(createOrUpdateProvider).toHaveBeenCalledWith(
        expect.objectContaining({ id: updateId }),
        expect.any(Array),
        storedSnapshot()
      );
    });

    it("conditions a save that brings a fresh key on the same snapshot", async () => {
      await POST(
        postRequest({
          id: updateId,
          displayName: "Acme LLM",
          baseUrl: "https://new-host.example.com/v1",
          apiKey: SECRET_KEY,
        }),
        routeCtx
      );

      expect(createOrUpdateProvider).toHaveBeenCalledWith(
        expect.objectContaining({ id: updateId }),
        expect.any(Array),
        storedSnapshot()
      );
    });

    it("answers 409 and audits a failure when the row changed while discovery ran", async () => {
      vi.mocked(createOrUpdateProvider).mockRejectedValueOnce(new ProviderChangedError(updateId));

      const res = await POST(
        postRequest({
          id: updateId,
          displayName: "Acme LLM",
          baseUrl: "https://acme.example.com/v1",
        }),
        routeCtx
      );

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "This provider changed while you were saving. Reload and try again.",
      });
      expect(regenerateOpenClawConfig).not.toHaveBeenCalled();
      expect(recordAuditFailure).not.toHaveBeenCalled();
      expect(appendAuditLog).toHaveBeenCalledTimes(1);
      const entry = vi.mocked(appendAuditLog).mock.calls[0][0];
      expect(entry).toMatchObject({
        eventType: "config.changed",
        outcome: "failure",
        detail: {
          provider: { id: "acme-llm", name: "Acme LLM" },
          authType: "openai-compatible",
          reason: "provider_changed_during_save",
        },
      });
      expect(JSON.stringify(entry)).not.toContain("sk-stored-key");
      expect(JSON.stringify(entry)).not.toContain("ciphertext-of-the-stored-key");
    });

    // The row existed when the snapshot was read and was deleted while
    // discovery ran. That is the same "not found" the up-front check answers
    // with 404 — not a persist failure worth a 500 and a recordAuditFailure.
    it("answers 404 and audits a failure when the row was deleted while discovery ran", async () => {
      vi.mocked(createOrUpdateProvider).mockRejectedValueOnce(new ProviderNotFoundError(updateId));

      const res = await POST(
        postRequest({
          id: updateId,
          displayName: "Acme LLM",
          baseUrl: "https://acme.example.com/v1",
        }),
        routeCtx
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "OpenAI-compatible provider not found." });
      expect(regenerateOpenClawConfig).not.toHaveBeenCalled();
      expect(recordAuditFailure).not.toHaveBeenCalled();
      expect(appendAuditLog).toHaveBeenCalledTimes(1);
      const entry = vi.mocked(appendAuditLog).mock.calls[0][0];
      expect(entry).toMatchObject({
        eventType: "config.changed",
        outcome: "failure",
        detail: {
          provider: { id: "acme-llm", name: "Acme LLM" },
          authType: "openai-compatible",
          reason: "provider_deleted_during_save",
          baseUrlHost: "acme.example.com",
        },
      });
      expect(JSON.stringify(entry)).not.toContain("sk-stored-key");
      expect(JSON.stringify(entry)).not.toContain("ciphertext-of-the-stored-key");
    });
  });

  // The live-model cache used to be keyed by slug alone and cleared only AFTER
  // the regenerate, so the regenerate a re-pointing save triggers could emit
  // the OLD endpoint's cached model list under the NEW base URL. The cache is
  // now keyed by the destination too (openai-compatible-discovery.test.ts), and
  // it is cleared before the regenerate reads it.
  it("clears the model cache BEFORE regenerating, so the regenerate discovers afresh", async () => {
    await POST(
      postRequest({
        id: "11111111-1111-4111-8111-111111111111",
        displayName: "Acme LLM",
        baseUrl: "https://new-host.example.com/v1",
        apiKey: SECRET_KEY,
      }),
      routeCtx
    );

    expect(resetCache).toHaveBeenCalledTimes(1);
    expect(regenerateOpenClawConfig).toHaveBeenCalledTimes(1);
    expect(vi.mocked(resetCache).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(regenerateOpenClawConfig).mock.invocationCallOrder[0]
    );
  });

  it("rejects an invalid body (empty displayName) with a structured 400 and no side effects", async () => {
    const res = await POST(
      postRequest({
        displayName: "",
        baseUrl: "https://acme.example.com/v1",
        apiKey: SECRET_KEY,
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

  it("correlates an UPDATE failure by the stored provider identity in the failure audit", async () => {
    const updateId = "22222222-2222-4222-8222-222222222222";
    vi.mocked(createOrUpdateProvider).mockRejectedValueOnce(new Error("db exploded"));

    const res = await POST(
      postRequest({
        id: updateId,
        displayName: "Acme Renamed",
        baseUrl: "https://acme.example.com/v1",
        // No apiKey on an update — nothing to leak.
      }),
      routeCtx
    );

    expect(res.status).toBe(500);
    expect(appendAuditLog).not.toHaveBeenCalled();
    expect(recordAuditFailure).toHaveBeenCalledTimes(1);
    const [, entry] = vi.mocked(recordAuditFailure).mock.calls[0];
    expect(entry.outcome).toBe("failure");
    // The stored row was read before the write, so the failure names the
    // provider the way every other provider row does — by slug, with the name
    // it actually has (the failed save renamed nothing).
    expect(entry.detail).toMatchObject({
      provider: { id: "acme-llm", name: "Acme LLM" },
    });
    expect(JSON.stringify(entry.detail)).not.toContain(SECRET_KEY);
  });

  it("never returns the api key in the response body", async () => {
    const res = await POST(
      postRequest({
        displayName: "Acme LLM",
        baseUrl: "https://acme.example.com/v1",
        apiKey: SECRET_KEY,
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

  it("flags a provider whose saved base URL is now refused, with the reason and no address", async () => {
    // Config emission points such a provider at a reserved address
    // (refusedBaseUrlsForEmission), so the settings page has to say so —
    // otherwise the admin only sees agents failing. Same guard, same verdict.
    vi.mocked(listOpenAiCompatibleProvidersForAdmin).mockResolvedValue([
      listItem({ id: "row-ok", slug: "acme-llm", baseUrl: "https://acme.example.com/v1" }),
      listItem({ id: "row-imds", slug: "imds", baseUrl: "http://100.100.100.200/v1" }),
    ]);
    vi.mocked(assertAllowedProviderUrl).mockImplementation(async (url: string) => {
      if (url.includes("100.100.100.200")) {
        throw new ProviderUrlBlockedError(
          "blocked_address",
          "That host resolves to a reserved or internal address that isn't allowed."
        );
      }
    });

    let data: Array<{ refusedReason: string | null }>;
    try {
      const res = await GET(makeNextRequest(), routeCtx);
      expect(res.status).toBe(200);
      data = await res.json();
    } finally {
      // clearAllMocks keeps implementations; don't leak this one.
      vi.mocked(assertAllowedProviderUrl).mockResolvedValue(undefined);
    }
    expect(data[0].refusedReason).toBeNull();
    expect(data[1].refusedReason).toBe(
      "That host resolves to a reserved or internal address that isn't allowed."
    );
    expect(data[1].refusedReason).not.toContain("100.100.100.200");
    // Reading the list is not a state change: no audit row, on any GET.
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

  /** A usable provider that survives the delete — what countConfiguredProviders() = 2 implies. */
  function anotherBuiltInRemains() {
    vi.mocked(listConfiguredBuiltIns).mockResolvedValue([
      {
        name: "anthropic",
        config: { defaultModel: "anthropic/claude-haiku-4-5-20251001" },
      },
    ] as any);
  }

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
    // The DELETE runs while the row still exists — it is what removes it.
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([listItem({ id: PROVIDER_ID })]);
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(regenerateOpenClawConfig).mockResolvedValue(undefined);
    vi.mocked(db.query.agents.findMany).mockResolvedValue([]);
    vi.mocked(deleteProviderById).mockResolvedValue({
      id: PROVIDER_ID,
      slug: "acme-llm",
      displayName: "Acme LLM",
    });
    // clearAllMocks keeps implementations: undo a refusal set by an earlier test.
    vi.mocked(assertAllowedProviderUrl).mockResolvedValue(undefined);
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

  // A remaining custom provider whose saved base URL the SSRF guard refuses is
  // emitted pointed at a reserved address with no key, so it cannot take the
  // agents (or the default) this delete would hand it. The check runs BEFORE
  // the row is deleted — afterwards there is nothing left to refuse.
  it("refuses to delete when the only other provider's base URL is refused", async () => {
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([
      listItem({ id: PROVIDER_ID }),
      listItem({ id: "row-id-2", slug: "cgnat", baseUrl: "http://100.100.100.200/v1" }),
    ]);
    vi.mocked(assertAllowedProviderUrl).mockImplementation(async (url: string) => {
      if (url.includes("100.100.100.200")) {
        throw new ProviderUrlBlockedError(
          "blocked_address",
          "That host resolves to a reserved or internal address that isn't allowed."
        );
      }
    });

    const res = await DELETE(deleteRequest({ id: PROVIDER_ID }), routeCtx);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/last usable provider/i);
    expect(deleteProviderById).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(setSetting).not.toHaveBeenCalled();

    // The SSRF verdict turned an admin action down: recorded as a failure,
    // like PATCH /default's refusal — with the provider's name, never the
    // refused address.
    expect(appendAuditLog).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(entry).toMatchObject({
      eventType: "config.changed",
      outcome: "failure",
      detail: {
        action: "provider_delete_refused_no_usable_target",
        reason: "last_usable_provider",
        provider: { id: PROVIDER_ID, name: "Acme LLM" },
      },
    });
    expect(data.error).toBe(LAST_USABLE_PROVIDER_ERROR);
    expect(JSON.stringify(entry)).not.toContain("100.100.100.200");
  });

  // "Cannot remove the last usable provider" is false when the provider being
  // removed is refused too: it was never usable. Two refused LAN providers and
  // no built-in is the shape that produced it. The dialog and the DELETE must
  // still say one and the same sentence, and the audit row must tell the two
  // cases apart without a second action name.
  it("says no usable provider would remain, not 'last usable provider', when the removed one is refused too", async () => {
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([
      listItem({
        id: PROVIDER_ID,
        slug: "lan-a",
        displayName: "LAN A",
        baseUrl: "http://100.100.100.200/v1",
      }),
      listItem({
        id: "row-id-2",
        slug: "lan-b",
        displayName: "LAN B",
        baseUrl: "http://100.64.0.7/v1",
      }),
    ]);
    vi.mocked(assertAllowedProviderUrl).mockImplementation(async () => {
      throw new ProviderUrlBlockedError("blocked_address", "refused");
    });

    const previewRes = await PREVIEW(
      makeNextRequest("http://localhost/api/settings/providers/deletion-preview?provider=lan-a"),
      routeCtx
    );
    expect(previewRes.status).toBe(200);
    const previewed = await previewRes.json();
    expect(previewed.refusal).toBe(NO_USABLE_TARGET_FOR_REFUSED_PROVIDER_ERROR);
    expect(previewed.refusal).not.toMatch(/last usable provider/i);

    const res = await DELETE(deleteRequest({ id: PROVIDER_ID }), routeCtx);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(previewed.refusal);
    expect(deleteProviderById).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(setSetting).not.toHaveBeenCalled();

    expect(appendAuditLog).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(entry).toMatchObject({
      eventType: "config.changed",
      outcome: "failure",
      detail: {
        action: "provider_delete_refused_no_usable_target",
        reason: "provider_itself_refused",
        provider: { id: PROVIDER_ID, name: "LAN A" },
      },
    });
    expect(JSON.stringify(entry)).not.toContain("100.100.100.200");
    expect(JSON.stringify(entry)).not.toContain("100.64.0.7");
  });

  // An unknown id is a 404 whatever else is configured. The usable-target
  // guard used to run first, so a stale id answered 400 "last usable provider"
  // and wrote a refusal audit naming the id as if it were a provider.
  it("returns 404, not the no-usable-target refusal, for an id that matches no provider", async () => {
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([
      listItem({ id: "row-id-2", slug: "cgnat", baseUrl: "http://100.100.100.200/v1" }),
    ]);
    vi.mocked(assertAllowedProviderUrl).mockImplementation(async () => {
      throw new ProviderUrlBlockedError("blocked_address", "refused");
    });

    const res = await DELETE(deleteRequest({ id: PROVIDER_ID }), routeCtx);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "OpenAI-compatible provider not found." });
    expect(deleteProviderById).not.toHaveBeenCalled();
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 404, not the last-configured refusal, for an unknown id when one provider is configured", async () => {
    vi.mocked(countConfiguredProviders).mockResolvedValue(1);
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([]);

    const res = await DELETE(deleteRequest({ id: PROVIDER_ID }), routeCtx);

    expect(res.status).toBe(404);
    expect(deleteProviderById).not.toHaveBeenCalled();
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("migrates past a refused custom provider onto a usable one", async () => {
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([
      listItem({ id: PROVIDER_ID }),
      listItem({ id: "row-id-2", slug: "cgnat", baseUrl: "http://100.100.100.200/v1" }),
      listItem({ id: "row-id-3", slug: "other-llm", models: [modelDef("other-large")] }),
    ]);
    vi.mocked(assertAllowedProviderUrl).mockImplementation(async (url: string) => {
      if (url.includes("100.100.100.200")) {
        throw new ProviderUrlBlockedError("blocked_address", "refused");
      }
    });
    vi.mocked(getSetting).mockImplementation(async (key: string) =>
      key === "default_provider" ? "acme-llm" : null
    );
    vi.mocked(db.query.agents.findMany).mockResolvedValue([
      { id: "agent-1", name: "Smithers", model: "acme-llm/acme-large" },
    ] as any);
    const setSpy = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    vi.mocked(db.update).mockReturnValue({ set: setSpy } as any);

    const res = await DELETE(deleteRequest({ id: PROVIDER_ID }), routeCtx);

    expect(res.status).toBe(200);
    expect(setSpy).toHaveBeenCalledWith({ model: "other-llm/other-large" });
    expect(setSetting).toHaveBeenCalledWith("default_provider", "other-llm", false);
  });

  it("returns 404 when the id does not match a provider (no migration, no success audit)", async () => {
    anotherBuiltInRemains();
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
      configRegenerated: true,
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
    // The row being deleted (still listed — the DELETE removes it) and the
    // remaining custom instance.
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([
      listItem({ id: PROVIDER_ID }),
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

  // #949 — the removal dialog names the target BEFORE the delete, from a
  // preflight route. Its whole reason to exist is that it must not drift from
  // what the delete then does, so assert the agreement on the custom path too:
  // the preview runs while the row still exists (and must exclude it by slug),
  // the delete runs after it's gone.
  it("agrees with the deletion preview on the target model for the same state", async () => {
    vi.mocked(listConfiguredBuiltIns).mockResolvedValue([
      {
        name: "anthropic",
        config: { name: "Anthropic", defaultModel: "anthropic/claude-haiku-4-5-20251001" },
      },
    ] as any);
    vi.mocked(db.query.agents.findMany).mockResolvedValue([
      { id: "agent-1", name: "Booker", model: "acme-llm/acme-large" },
    ] as any);

    // Pre-delete state: the row the admin is about to remove is still listed.
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([listItem()]);
    const previewRes = await PREVIEW(
      makeNextRequest("http://localhost/api/settings/providers/deletion-preview?provider=acme-llm"),
      routeCtx
    );
    expect(previewRes.status).toBe(200);
    const previewed = await previewRes.json();
    expect(previewed.targetProviderLabel).toBe("Anthropic");
    expect(previewed.affectedAgents).toEqual([{ id: "agent-1", name: "Booker" }]);

    // The DELETE sees the same pre-delete state: it lists the row (to 404 an
    // unknown id and exclude this one from the targets) before removing it.
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([listItem({ id: PROVIDER_ID })]);
    const setSpy = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    vi.mocked(db.update).mockReturnValue({ set: setSpy } as any);

    const res = await DELETE(deleteRequest({ id: PROVIDER_ID }), routeCtx);

    expect(res.status).toBe(200);
    expect(setSpy).toHaveBeenCalledWith({ model: previewed.targetModel });
    expect(await res.json()).toMatchObject({
      ok: true,
      migratedAgents: previewed.affectedAgents.length,
    });
  });

  it("still succeeds with configRegenerated:false when regenerate throws (best-effort)", async () => {
    anotherBuiltInRemains();
    vi.mocked(regenerateOpenClawConfig).mockRejectedValueOnce(new Error("EACCES"));

    const res = await DELETE(deleteRequest({ id: PROVIDER_ID }), routeCtx);

    expect(res.status).toBe(200);
    expect(resetCache).toHaveBeenCalled();
    const entry = vi.mocked(appendAuditLog).mock.calls[0][0];
    expect(entry.detail).toMatchObject({ configRegenerated: false });
  });
});
