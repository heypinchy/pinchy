import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { refusedBaseUrlReason, withoutRefusedBaseUrls } from "@/lib/openai-compatible-stored-url";
import type { HostResolver } from "@/lib/provider-url-guard";

/**
 * Config emission must not hand OpenClaw a saved OpenAI-compatible provider
 * whose base URL the SSRF guard now refuses. OpenClaw carries the chat traffic
 * (with the provider's key) to whatever `models.providers.<slug>.baseUrl`
 * says, so a URL refused at use and emitted anyway is a refusal that protects
 * nothing.
 *
 * Every test injects its resolver; none touches real DNS.
 */
const resolveTo =
  (...addresses: string[]): HostResolver =>
  async () =>
    addresses;
const unresolvable: HostResolver = async () => {
  throw new Error("ENOTFOUND");
};

const provider = (slug: string, baseUrl: string) => ({
  slug,
  displayName: `${slug} display`,
  baseUrl,
});

describe("withoutRefusedBaseUrls", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    vi.unstubAllEnvs();
  });

  it("drops a provider whose saved base URL is now refused, and keeps the rest in order", async () => {
    const providers = [
      provider("first", "https://93.184.216.34/v1"),
      provider("metadata", "http://169.254.169.254/v1"),
      provider("last", "http://10.0.0.5:8000/v1"),
    ];

    const kept = await withoutRefusedBaseUrls(providers, unresolvable);

    expect(kept.map((p) => p.slug)).toEqual(["first", "last"]);
    // The same objects, not copies: the caller reads further fields off them.
    expect(kept[0]).toBe(providers[0]);
  });

  it("says which provider it left out and why, without the URL", async () => {
    await withoutRefusedBaseUrls([provider("metadata", "http://169.254.169.254/v1")], unresolvable);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain("metadata display");
    expect(message).toContain("(metadata)");
    expect(message).toContain("reserved or internal address");
    expect(message).not.toContain("169.254.169.254");
  });

  it("checks what a name resolves to, not only literals", async () => {
    const kept = await withoutRefusedBaseUrls(
      [provider("rebound", "https://llm.acme.example/v1")],
      resolveTo("100.100.100.200")
    );

    expect(kept).toEqual([]);
  });

  it("drops a LAN provider once PINCHY_PROVIDER_BLOCK_PRIVATE_NETWORKS is set", async () => {
    const lan = [provider("lan", "http://vllm.lan.example:8000/v1")];

    expect(await withoutRefusedBaseUrls(lan, resolveTo("10.0.0.5"))).toEqual(lan);

    vi.stubEnv("PINCHY_PROVIDER_BLOCK_PRIVATE_NETWORKS", "1");
    expect(await withoutRefusedBaseUrls(lan, resolveTo("10.0.0.5"))).toEqual([]);
    expect(String(warn.mock.calls[0][0])).toContain("private network");
  });

  it("keeps a provider whose name does not resolve right now (fail open, like every guard)", async () => {
    const providers = [provider("offline", "https://llm.acme.example/v1")];

    expect(await withoutRefusedBaseUrls(providers, unresolvable)).toEqual(providers);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("refusedBaseUrlReason", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // The settings page shows this next to the provider, so the admin can see
  // why it is left out of the config. Same verdict as the emission filter.
  it("is null for a base URL the guard allows", async () => {
    expect(await refusedBaseUrlReason("https://93.184.216.34/v1", unresolvable)).toBeNull();
  });

  it("is the guard's reason, without the address, for a refused one", async () => {
    const reason = await refusedBaseUrlReason(
      "https://llm.acme.example/v1",
      resolveTo("100.100.100.200")
    );

    expect(reason).toContain("reserved or internal address");
    expect(reason).not.toContain("100.100.100.200");
  });

  it("follows PINCHY_PROVIDER_BLOCK_PRIVATE_NETWORKS", async () => {
    vi.stubEnv("PINCHY_PROVIDER_BLOCK_PRIVATE_NETWORKS", "1");

    expect(await refusedBaseUrlReason("http://10.0.0.5:8000/v1", unresolvable)).toContain(
      "private network"
    );
  });

  it("is null for a name that does not resolve right now (fail open)", async () => {
    expect(await refusedBaseUrlReason("https://llm.acme.example/v1", unresolvable)).toBeNull();
  });

  it("does not log: the emission filter owns the log line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await refusedBaseUrlReason("http://169.254.169.254/v1", unresolvable);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
