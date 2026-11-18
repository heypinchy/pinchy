// Real-DB race test for POST /api/settings/providers/openai-compatible (review
// finding on #1238). The route checks where a stored key may go, then runs
// model discovery against the submitted base URL — a request to a host the
// caller may control and can hold open for ~10s — and only then writes. A
// keyless save held open that long must not land after an admin has
// re-entered the real key: that would pair the caller's URL with the real key.
//
// Discovery is the only mocked step on the path (plus the session, the SSRF
// guard's DNS lookup, the runtime push and the audit writer); the check and
// the conditional write run against Postgres.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { openaiCompatibleProviders } from "@/db/schema";
import { decrypt } from "@/lib/encryption";
import { createOrUpdateProvider, getProviderSnapshotById } from "@/lib/openai-compatible-providers";
import type { OpenClawModelDefinition } from "@/lib/openclaw-builtin-models";
import { makeNextRequest, routeContext } from "@/test-helpers/route";

const { getSessionMock, appendAuditLogMock, fetchModelsMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  appendAuditLogMock: vi.fn(),
  fetchModelsMock: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
// Outside a request scope Next's after() has nowhere to defer to; run the
// callback inline (the success audit is mocked anyway).
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn((fn: () => unknown) => void fn()),
}));
vi.mock("@/lib/auth", () => ({
  getSession: getSessionMock,
  auth: { api: { getSession: getSessionMock } },
}));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  appendAuditLog: appendAuditLogMock,
}));
vi.mock("@/lib/openai-compatible-discovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openai-compatible-discovery")>()),
  fetchOpenAiCompatibleModels: fetchModelsMock,
}));
vi.mock("@/lib/provider-url-guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/provider-url-guard")>()),
  assertAllowedProviderUrl: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

const { POST } = await import("@/app/api/settings/providers/openai-compatible/route");

const MODEL: OpenClawModelDefinition = {
  id: "acme-large",
  name: "Acme Large",
  contextWindow: 128_000,
  maxTokens: 8_192,
  reasoning: false,
  vision: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function post(body: unknown) {
  return POST(
    makeNextRequest("http://localhost/api/settings/providers/openai-compatible", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    routeContext()
  );
}

async function storedRow(id: string) {
  const [row] = await db
    .select()
    .from(openaiCompatibleProviders)
    .where(eq(openaiCompatibleProviders.id, id));
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue({
    user: { id: "race-admin", email: "race-admin@test.com", role: "admin" },
  });
  fetchModelsMock.mockResolvedValue([MODEL]);
});

describe("POST /api/settings/providers/openai-compatible — check-to-write race", () => {
  it("refuses a held keyless save once the real key was re-entered meanwhile (409, row untouched)", async () => {
    // The caller already controls the address (it was saved with their own
    // key), so a keyless save to that same address passes the destination check.
    const created = await createOrUpdateProvider(
      { displayName: "Acme LLM", baseUrl: "https://evil.example/v1", apiKey: "sk-attacker" },
      [MODEL]
    );

    // While discovery is held open, the real admin moves the provider back
    // and re-enters the real key.
    fetchModelsMock.mockImplementationOnce(async () => {
      await createOrUpdateProvider(
        {
          id: created.id,
          displayName: "Acme LLM",
          baseUrl: "https://api.acme.example/v1",
          apiKey: "sk-real",
        },
        [MODEL],
        await getProviderSnapshotById(created.id)
      );
      return [MODEL];
    });

    const res = await post({
      id: created.id,
      displayName: "Acme LLM",
      baseUrl: "https://evil.example/v1",
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "This provider changed while you were saving. Reload and try again.",
    });
    const row = await storedRow(created.id);
    expect(row.baseUrl).toBe("https://api.acme.example/v1");
    expect(decrypt(row.apiKey)).toBe("sk-real");
    expect(appendAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "config.changed",
        outcome: "failure",
        detail: expect.objectContaining({
          provider: { id: created.slug, name: "Acme LLM" },
          reason: "provider_changed_during_save",
        }),
      })
    );
  });

  it("still saves a keyless rename when nothing changed in between", async () => {
    const created = await createOrUpdateProvider(
      { displayName: "Acme LLM", baseUrl: "https://api.acme.example/v1", apiKey: "sk-real" },
      [MODEL]
    );

    const res = await post({
      id: created.id,
      displayName: "Acme Renamed",
      baseUrl: "https://api.acme.example/v1",
    });

    expect(res.status).toBe(200);
    const row = await storedRow(created.id);
    expect(row.displayName).toBe("Acme Renamed");
    expect(decrypt(row.apiKey)).toBe("sk-real");
    expect(fetchModelsMock).toHaveBeenCalledWith("https://api.acme.example/v1", "sk-real");
  });
});
