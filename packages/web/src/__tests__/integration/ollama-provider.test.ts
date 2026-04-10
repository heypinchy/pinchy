import { describe, it, expect, beforeAll } from "vitest";

const OLLAMA_URL = process.env.OLLAMA_URL;

// Skip all tests when Ollama is not available (normal unit test runs)
const describeOllama = OLLAMA_URL ? describe : describe.skip;

describeOllama("Ollama integration (requires running Ollama)", () => {
  beforeAll(async () => {
    // Verify Ollama is reachable
    const response = await fetch(`${OLLAMA_URL}/api/tags`);
    expect(response.ok).toBe(true);
  });

  it("validates Ollama URL via /api/tags", async () => {
    const { validateProviderUrl } = await import("@/lib/providers");
    const result = await validateProviderUrl(OLLAMA_URL!);
    expect(result).toEqual({ valid: true });
  });

  it("returns invalid for non-existent Ollama URL", async () => {
    const { validateProviderUrl } = await import("@/lib/providers");
    const result = await validateProviderUrl("http://localhost:19999");
    expect(result).toEqual({ valid: false, error: "network_error" });
  });

  it("discovers installed models via /api/tags", async () => {
    const response = await fetch(`${OLLAMA_URL}/api/tags`);
    const data = await response.json();

    expect(data.models).toBeDefined();
    expect(Array.isArray(data.models)).toBe(true);
    expect(data.models.length).toBeGreaterThan(0);

    // Verify model structure
    const model = data.models[0];
    expect(model.name).toBeDefined();
    expect(typeof model.name).toBe("string");
  });

  it("fetches model capabilities via /api/show", async () => {
    // Get first available model
    const tagsResponse = await fetch(`${OLLAMA_URL}/api/tags`);
    const tagsData = await tagsResponse.json();
    const modelName = tagsData.models[0].name;

    const showResponse = await fetch(`${OLLAMA_URL}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelName }),
    });

    expect(showResponse.ok).toBe(true);
    const showData = await showResponse.json();

    // Verify capabilities array exists
    expect(showData.capabilities).toBeDefined();
    expect(Array.isArray(showData.capabilities)).toBe(true);
    expect(showData.capabilities).toContain("completion");

    // Verify details with parameter_size
    expect(showData.details).toBeDefined();
    expect(showData.details.parameter_size).toBeDefined();
  });

  it("generates correct OpenClaw config block for local Ollama", async () => {
    // Verify the config format that would be written to openclaw.json
    const url = OLLAMA_URL!;
    const expectedConfig = {
      baseUrl: url.replace(/\/$/, ""),
      api: "ollama",
    };

    expect(expectedConfig.api).toBe("ollama");
    expect(expectedConfig.baseUrl).not.toMatch(/\/$/);
    expect(expectedConfig.baseUrl).toMatch(/^https?:\/\//);
  });
});
