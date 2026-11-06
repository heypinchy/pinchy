// The model caches a regenerate reads are process-wide.
//
// One Pinchy process loads these modules twice: the custom server (tsx) and
// Next's route bundles. Regenerates are serialized by one process-wide queue
// (regenerate-queue.ts), so a coalesced rerun is started by whichever module
// instance's run just settled — and reads THAT instance's caches. A reset made
// through the other instance (model self-heal in the server, a provider save in
// a route) must therefore reach every instance, or the rerun regenerates from a
// list the reset was meant to throw away: self-heal re-pins the retired model,
// then sits out its cooldown.
//
// Two instances are simulated with `vi.resetModules()` between two imports of
// the same module. Each test resets through one and reads through the other,
// calling the exact functions `regenerateOpenClawConfigOnce` calls.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  capabilityRows: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/settings", () => ({ getSetting: mocks.getSetting }));
vi.mock("@/lib/model-vision", () => ({
  isModelVisionCapable: vi.fn().mockReturnValue(false),
  setOllamaLocalVisionModels: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/openai-compatible-providers", () => ({
  listProvidersForModelFetch: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/db", () => ({
  db: { select: () => ({ from: async () => mocks.capabilityRows }) },
}));

global.fetch = vi.fn();

// The custom-provider probe resolves its host once and connects to that answer
// through `pinnedFetch`. Neither half is under test here: the name gets a
// public answer without touching real DNS, and the pinned request goes to the
// mocked global fetch like every other request in this file.
vi.mock("dns/promises", () => {
  const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
  return { default: { lookup }, lookup };
});
vi.mock("@/lib/pinned-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pinned-connection")>()),
  pinnedFetch: (url: string, init: RequestInit) => fetch(url, init),
}));

async function twoProviderModelInstances() {
  vi.resetModules();
  const a = await import("@/lib/provider-models");
  vi.resetModules();
  const b = await import("@/lib/provider-models");
  expect(a).not.toBe(b);
  return [a, b] as const;
}

function anthropicCatalog(ids: string[]) {
  return new Response(JSON.stringify({ data: ids.map((id) => ({ id, display_name: id })) }), {
    status: 200,
  });
}

beforeEach(async () => {
  vi.mocked(fetch).mockReset();
  mocks.getSetting.mockReset();
  mocks.getSetting.mockResolvedValue(null);
  mocks.capabilityRows = [];
  // Start every test from empty process-wide caches, whatever an earlier test
  // (or file in this worker) left behind.
  const [a] = await twoProviderModelInstances();
  a.resetCache();
  (await import("@/lib/model-capabilities/cache")).invalidateModelCapabilityCache();
});

describe("model caches are shared by every module instance in the process", () => {
  it("a resetCache() through one instance makes the other refetch the cloud catalog", async () => {
    mocks.getSetting.mockImplementation(async (key: string) =>
      key === "anthropic_api_key" ? "sk-ant-test" : null
    );
    const [server, route] = await twoProviderModelInstances();

    vi.mocked(fetch).mockResolvedValueOnce(anthropicCatalog(["claude-sonnet-4-5"]));
    expect(await server.getDefaultModel("anthropic")).toBe("anthropic/claude-sonnet-4-5");

    // The retired model is gone from the provider's catalog; the route that
    // learned it resets the cache before triggering a regenerate.
    vi.mocked(fetch).mockResolvedValueOnce(anthropicCatalog(["claude-sonnet-4-6"]));
    route.resetCache();

    // The regenerate rerun runs through the OTHER instance.
    expect(await server.getDefaultModel("anthropic")).toBe("anthropic/claude-sonnet-4-6");
  });

  it("a resetCache() through one instance makes the other refetch local Ollama models", async () => {
    const [server, route] = await twoProviderModelInstances();
    const ollama = (names: string[]) => {
      vi.mocked(fetch).mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/api/tags")) {
          return new Response(JSON.stringify({ models: names.map((name) => ({ name })) }));
        }
        return new Response(JSON.stringify({ capabilities: ["completion", "tools"] }));
      });
    };

    ollama(["qwen3:8b"]);
    const first = await server.fetchOllamaLocalModelsFromUrl("http://ollama:11434");
    expect(first.map((m) => m.id)).toEqual(["ollama/qwen3:8b"]);

    ollama(["qwen3:32b"]);
    route.resetCache();

    const second = await server.fetchOllamaLocalModelsFromUrl("http://ollama:11434");
    expect(second.map((m) => m.id)).toEqual(["ollama/qwen3:32b"]);
  });

  it("a resetCache() through one instance makes the other refetch a custom provider's models", async () => {
    vi.resetModules();
    const server = await import("@/lib/openai-compatible-discovery");
    const [route] = await twoProviderModelInstances();
    const source = {
      slug: "acme",
      baseUrl: "https://api.acme.example/v1",
      apiKey: "sk-acme",
      keyVersion: "v1",
      models: [],
    };
    const live = (ids: string[]) =>
      vi
        .mocked(fetch)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 })
        );

    live(["acme-old"]);
    expect((await server.resolveCustomProviderModels(source)).map((m) => m.id)).toEqual([
      "acme-old",
    ]);

    live(["acme-new"]);
    route.resetCache();

    expect((await server.resolveCustomProviderModels(source)).map((m) => m.id)).toEqual([
      "acme-new",
    ]);
  });

  it("a capability cache reload through one instance is what the other reads", async () => {
    vi.resetModules();
    const server = await import("@/lib/model-capabilities/cache");
    vi.resetModules();
    const route = await import("@/lib/model-capabilities/cache");
    expect(server).not.toBe(route);
    const row = (vision: boolean) => ({
      provider: "ollama",
      modelId: "llava:13b",
      vision,
      longContext: false,
      tools: true,
    });

    mocks.capabilityRows = [row(false)];
    await server.ensureModelCapabilityCacheLoaded();
    expect(server.getModelCapabilities("ollama/llava:13b")?.vision).toBe(false);

    // What setOllamaLocalVisionModels does after its upsert, in the route.
    mocks.capabilityRows = [row(true)];
    route.invalidateModelCapabilityCache();
    await route.loadModelCapabilityCache();

    await server.ensureModelCapabilityCacheLoaded();
    expect(server.getModelCapabilities("ollama/llava:13b")?.vision).toBe(true);
  });

  it("local Ollama models primed through one instance are what the other picks a default from", async () => {
    const [server, route] = await twoProviderModelInstances();
    const primed = [
      {
        id: "ollama/qwen3:32b",
        name: "qwen3:32b",
        parameterSize: "32B",
        capabilities: { vision: false, tools: true, completion: true, thinking: false },
      },
    ];

    route.setOllamaLocalModels(primed);

    expect(server.getOllamaLocalModels()).toEqual(primed);
  });
});
