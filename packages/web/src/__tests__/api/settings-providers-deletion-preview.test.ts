import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "@/app/api/settings/providers/deletion-preview/route";
import { DELETE } from "@/app/api/settings/providers/route";

// #949 — the removal dialog names the migration target instead of "another
// configured provider". The target is picked by `buildRemainingCandidates()`
// (built-ins first, first candidate wins), so the preview MUST go through that
// same helper rather than re-deriving the ordering. The load-bearing test here
// is the last one: preview and DELETE must agree on the target for one and the
// same state — that agreement is the entire reason this route exists.

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
  deleteSetting: vi.fn().mockResolvedValue(undefined),
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

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as object), eq: vi.fn() };
});

import { auth } from "@/lib/auth";
import { getSetting } from "@/lib/settings";
import { listOpenAiCompatibleProviders } from "@/lib/openai-compatible-providers";
import type { OpenAiCompatibleProviderListItem } from "@/lib/openai-compatible-providers";
import { db } from "@/db";
import { PROVIDERS } from "@/lib/providers";
import { mockSession } from "@/test-helpers/auth";
import { makeNextRequest, routeContext } from "@/test-helpers/route";
import type { DeletionPreviewResponse } from "@/lib/schemas/provider-deletion";

function customProvider(slug: string, displayName: string): OpenAiCompatibleProviderListItem {
  return {
    id: `id-${slug}`,
    slug,
    displayName,
    baseUrl: `https://${slug}.test/v1`,
    models: [
      {
        id: `${slug}-large`,
        name: `${slug} large`,
        contextWindow: 8192,
        maxTokens: 4096,
        reasoning: false,
        vision: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    keyHint: "abcd",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** Only these settings keys resolve — every other lookup is unconfigured. */
function configure(keys: Record<string, string>) {
  vi.mocked(getSetting).mockImplementation(async (key: string) => keys[key] ?? null);
}

function previewRequest(query: string) {
  return makeNextRequest(`http://localhost/api/settings/providers/deletion-preview${query}`);
}

async function preview(query: string): Promise<DeletionPreviewResponse> {
  const res = await GET(previewRequest(query), routeContext());
  expect(res.status).toBe(200);
  return (await res.json()) as DeletionPreviewResponse;
}

describe("GET /api/settings/providers/deletion-preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([]);
    vi.mocked(db.query.agents.findMany).mockResolvedValue([]);
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const res = await GET(previewRequest("?provider=anthropic"), routeContext());

    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-admin user", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(
      mockSession({ user: { id: "2", email: "user@test.com", role: "member" } })
    );

    const res = await GET(previewRequest("?provider=anthropic"), routeContext());

    expect(res.status).toBe(403);
  });

  it("returns a structured 400 when the provider param is missing", async () => {
    const res = await GET(previewRequest(""), routeContext());

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Validation failed");
    expect(data.details.fieldErrors.provider).toBeDefined();
  });

  it("returns 404 for a name that is neither a built-in nor a custom slug", async () => {
    const res = await GET(previewRequest("?provider=nope"), routeContext());

    expect(res.status).toBe(404);
  });

  it("names the target provider, its label, its model, and every affected agent", async () => {
    configure({ anthropic_api_key: "sk-ant", openai_api_key: "sk-openai" });
    vi.mocked(db.query.agents.findMany).mockResolvedValue([
      { id: "agent-1", name: "Hermes", model: "anthropic/claude-sonnet-4-6" },
      { id: "agent-2", name: "Booker", model: "openai/gpt-5.5" },
      { id: "agent-3", name: "Reader", model: "anthropic/claude-haiku-4-5" },
    ] as never);

    const data = await preview("?provider=anthropic");

    expect(data.targetProvider).toBe("openai");
    expect(data.targetProviderLabel).toBe("OpenAI");
    expect(data.targetModel).toBe(PROVIDERS.openai.defaultModel);
    expect(data.affectedAgents).toEqual([
      { id: "agent-1", name: "Hermes" },
      { id: "agent-3", name: "Reader" },
    ]);
  });

  it("reflects the built-ins-first ordering: a configured built-in beats a custom provider", async () => {
    configure({ google_api_key: "AIza", ollama_cloud_api_key: "sk-ollama" });
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([
      customProvider("acme", "Acme LLM"),
    ]);

    const data = await preview("?provider=ollama-cloud");

    expect(data.targetProvider).toBe("google");
    expect(data.targetModel).toBe(PROVIDERS.google.defaultModel);
  });

  it("previews a custom provider by slug, excluding it from its own candidate set", async () => {
    configure({ anthropic_api_key: "sk-ant" });
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([
      customProvider("acme", "Acme LLM"),
    ]);
    vi.mocked(db.query.agents.findMany).mockResolvedValue([
      { id: "agent-1", name: "Hermes", model: "acme/acme-large" },
    ] as never);

    const data = await preview("?provider=acme");

    expect(data.targetProvider).toBe("anthropic");
    expect(data.targetProviderLabel).toBe("Anthropic");
    expect(data.affectedAgents).toEqual([{ id: "agent-1", name: "Hermes" }]);
  });

  it("names a custom provider as the target with its display name and namespaced model", async () => {
    configure({ anthropic_api_key: "sk-ant" });
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([
      customProvider("acme", "Acme LLM"),
    ]);

    const data = await preview("?provider=anthropic");

    expect(data.targetProvider).toBe("acme");
    expect(data.targetProviderLabel).toBe("Acme LLM");
    expect(data.targetModel).toBe("acme/acme-large");
  });

  it("matches agents on the ollama/ prefix when removing ollama-local", async () => {
    configure({ ollama_local_url: "http://localhost:11434", anthropic_api_key: "sk-ant" });
    vi.mocked(db.query.agents.findMany).mockResolvedValue([
      { id: "agent-1", name: "Local", model: "ollama/llama3.2" },
      { id: "agent-2", name: "Cloud", model: "ollama-cloud/kimi-k2.6" },
    ] as never);

    const data = await preview("?provider=ollama-local");

    expect(data.affectedAgents).toEqual([{ id: "agent-1", name: "Local" }]);
  });

  it("returns an empty affected list — not a zero count — when nothing is pinned to the provider", async () => {
    configure({ anthropic_api_key: "sk-ant", openai_api_key: "sk-openai" });
    vi.mocked(db.query.agents.findMany).mockResolvedValue([
      { id: "agent-1", name: "Booker", model: "openai/gpt-5.5" },
    ] as never);

    const data = await preview("?provider=anthropic");

    expect(data.affectedAgents).toEqual([]);
    expect(data.targetProvider).toBe("openai");
  });

  it("reports no target when the provider is the only configured one", async () => {
    configure({ anthropic_api_key: "sk-ant" });
    vi.mocked(db.query.agents.findMany).mockResolvedValue([
      { id: "agent-1", name: "Hermes", model: "anthropic/claude-sonnet-4-6" },
    ] as never);

    const data = await preview("?provider=anthropic");

    expect(data.targetProvider).toBeNull();
    expect(data.targetProviderLabel).toBeNull();
    expect(data.targetModel).toBeNull();
    // Nothing migrates without a target, so nothing may be promised either.
    expect(data.affectedAgents).toEqual([]);
  });

  it("agrees with the DELETE route on the target model for the same state", async () => {
    configure({
      anthropic_api_key: "sk-ant",
      google_api_key: "AIza",
      openai_api_key: "sk-openai",
      default_provider: "anthropic",
    });
    vi.mocked(db.query.agents.findMany).mockResolvedValue([
      { id: "agent-1", name: "Hermes", model: "anthropic/claude-sonnet-4-6" },
    ] as never);

    const data = await preview("?provider=anthropic");

    const setSpy = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    vi.mocked(db.update).mockReturnValue({ set: setSpy } as never);

    const deleteRes = await DELETE(
      makeNextRequest("http://localhost/api/settings/providers", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "anthropic" }),
      }),
      routeContext()
    );

    expect(deleteRes.status).toBe(200);
    // The dialog promised `data.targetModel`; the DELETE must write exactly it.
    expect(setSpy).toHaveBeenCalledWith({ model: data.targetModel });
    expect(await deleteRes.json()).toMatchObject({
      success: true,
      migratedAgents: data.affectedAgents.length,
    });
  });
});
