import { describe, it, expect, vi, beforeEach } from "vitest";
import { getUsableDefaultProvider } from "../usable-default-provider";
import { getSetting } from "@/lib/settings";
import { listOpenAiCompatibleProviders } from "@/lib/openai-compatible-providers";
import type { OpenAiCompatibleProvider } from "@/lib/openai-compatible-providers";

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn(),
}));

vi.mock("@/lib/openai-compatible-providers", () => ({
  listOpenAiCompatibleProviders: vi.fn(),
}));

// Every base URL below is an address literal, so the guard classifies it
// without DNS. Nothing here may resolve a real name.
vi.mock("dns/promises", () => {
  const lookup = vi.fn(async () => {
    throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  });
  return { default: { lookup }, lookup };
});

function customProvider(slug: string, baseUrl: string): OpenAiCompatibleProvider {
  return {
    id: `row-${slug}`,
    slug,
    displayName: `${slug} display`,
    baseUrl,
    models: [],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function defaultProviderIs(value: string | null) {
  vi.mocked(getSetting).mockImplementation(async (key: string) =>
    key === "default_provider" ? value : null
  );
}

describe("getUsableDefaultProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([
      customProvider("lan-llm", "http://10.0.0.5:8000/v1"),
      customProvider("imds", "http://100.100.100.200/v1"),
    ]);
  });

  it("is null when no default provider is set", async () => {
    defaultProviderIs(null);
    expect(await getUsableDefaultProvider()).toBeNull();
  });

  it("returns a built-in default as is, without reading the custom providers", async () => {
    defaultProviderIs("anthropic");

    expect(await getUsableDefaultProvider()).toBe("anthropic");
    expect(listOpenAiCompatibleProviders).not.toHaveBeenCalled();
  });

  it("returns an OpenAI-compatible default whose saved base URL the guard allows", async () => {
    defaultProviderIs("lan-llm");
    expect(await getUsableDefaultProvider()).toBe("lan-llm");
  });

  // Config emission points this provider at a reserved address and drops it
  // as the runtime default. A new agent built on it would fail every run, so
  // template resolution treats it exactly like "no default provider".
  it("is null for an OpenAI-compatible default whose saved base URL is now refused", async () => {
    defaultProviderIs("imds");
    expect(await getUsableDefaultProvider()).toBeNull();
  });

  it("follows PINCHY_PROVIDER_BLOCK_PRIVATE_NETWORKS", async () => {
    vi.stubEnv("PINCHY_PROVIDER_BLOCK_PRIVATE_NETWORKS", "1");
    try {
      defaultProviderIs("lan-llm");
      expect(await getUsableDefaultProvider()).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("leaves a slug that matches no provider to the resolver's own 'Unknown provider' failure", async () => {
    defaultProviderIs("gone");
    expect(await getUsableDefaultProvider()).toBe("gone");
  });
});
