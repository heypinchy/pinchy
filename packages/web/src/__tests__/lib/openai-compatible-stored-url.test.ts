import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  REFUSED_BASE_URL,
  refusedBaseUrlReason,
  refusedBaseUrlReasons,
  refusedBaseUrlsForEmission,
} from "@/lib/openai-compatible-stored-url";
import { PROVIDER_DNS_LOOKUP_TIMEOUT_MS, type HostResolver } from "@/lib/provider-url-guard";

// The default resolver is reached only by the tests that leave the resolver
// out on purpose (the lookup timeout). It never answers — a resolver that
// hangs is the case under test, and no test here touches real DNS.
const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));
vi.mock("dns/promises", () => ({ default: { lookup: mockLookup }, lookup: mockLookup }));

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

describe("refusedBaseUrlsForEmission", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    vi.unstubAllEnvs();
  });

  it("names exactly the providers whose saved base URL is now refused, with the reason", async () => {
    const providers = [
      provider("first", "https://93.184.216.34/v1"),
      provider("metadata", "http://169.254.169.254/v1"),
      provider("last", "http://10.0.0.5:8000/v1"),
    ];

    const refused = await refusedBaseUrlsForEmission(providers, unresolvable);

    expect([...refused.keys()]).toEqual(["metadata"]);
    expect(refused.get("metadata")).toContain("reserved or internal address");
  });

  it("says which provider it left out and why, without the URL", async () => {
    await refusedBaseUrlsForEmission(
      [provider("metadata", "http://169.254.169.254/v1")],
      unresolvable
    );

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain("metadata display");
    expect(message).toContain("(metadata)");
    expect(message).toContain("reserved or internal address");
    expect(message).not.toContain("169.254.169.254");
  });

  it("checks what a name resolves to, not only literals", async () => {
    const refused = await refusedBaseUrlsForEmission(
      [provider("rebound", "https://llm.acme.example/v1")],
      resolveTo("100.100.100.200")
    );

    expect([...refused.keys()]).toEqual(["rebound"]);
  });

  it("drops a LAN provider once PINCHY_PROVIDER_BLOCK_PRIVATE_NETWORKS is set", async () => {
    const lan = [provider("lan", "http://vllm.lan.example:8000/v1")];

    expect((await refusedBaseUrlsForEmission(lan, resolveTo("10.0.0.5"))).size).toBe(0);

    vi.stubEnv("PINCHY_PROVIDER_BLOCK_PRIVATE_NETWORKS", "1");
    expect([...(await refusedBaseUrlsForEmission(lan, resolveTo("10.0.0.5"))).keys()]).toEqual([
      "lan",
    ]);
    expect(String(warn.mock.calls[0][0])).toContain("private network");
  });

  it("keeps a provider whose name does not resolve right now (fail open, like every guard)", async () => {
    const providers = [provider("offline", "https://llm.acme.example/v1")];

    expect((await refusedBaseUrlsForEmission(providers, unresolvable)).size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("refusedBaseUrlReason", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // The settings page shows this next to the provider, so the admin can see
  // why it is not in use. Same verdict as the emission check.
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

  it("does not log: the emission check owns the log line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await refusedBaseUrlReason("http://169.254.169.254/v1", unresolvable);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("REFUSED_BASE_URL", () => {
  // What a refused provider's entry points at instead of its saved URL. It
  // must be an address that cannot resolve anywhere (RFC 6761 reserves
  // `.invalid` for exactly that), and https, so even a resolver that answers
  // every name (fake-IP DNS) cannot complete a TLS handshake for it — the
  // request never gets as far as a header.
  it("is an https URL under the reserved .invalid top-level domain", () => {
    const url = new URL(REFUSED_BASE_URL);
    expect(url.protocol).toBe("https:");
    expect(url.hostname.endsWith(".invalid")).toBe(true);
  });
});

describe("refusedBaseUrlReasons", () => {
  afterEach(() => {
    vi.useRealTimers();
    mockLookup.mockReset();
  });

  it("maps each refused provider's slug to the reason and leaves allowed ones out", async () => {
    const reasons = await refusedBaseUrlReasons(
      [provider("ok", "https://93.184.216.34/v1"), provider("imds", "http://169.254.169.254/v1")],
      unresolvable
    );

    expect([...reasons.keys()]).toEqual(["imds"]);
    expect(reasons.get("imds")).toContain("reserved or internal address");
  });

  it("looks a host up once per call, however many providers share it", async () => {
    // One regenerate, or one settings-page load, asks once per host.
    const resolver = vi.fn<HostResolver>(async () => ["93.184.216.34"]);
    const providers = [
      provider("chat", "https://llm.acme.example/v1"),
      provider("embed", "https://llm.acme.example/embeddings/v1"),
      provider("other", "https://other.acme.example/v1"),
    ];

    await refusedBaseUrlReasons(providers, resolver);
    expect(resolver).toHaveBeenCalledTimes(2);

    // A later call asks again: a verdict lives for one call, not for good.
    await refusedBaseUrlReasons(providers, resolver);
    expect(resolver).toHaveBeenCalledTimes(4);
  });

  it("does not wait on a resolver that never answers: a timeout counts as unresolvable (fail open)", async () => {
    vi.useFakeTimers();
    mockLookup.mockImplementation(() => new Promise(() => {}));

    const pending = refusedBaseUrlReasons([provider("slow", "https://llm.acme.example/v1")]);
    let settled: Map<string, string> | undefined;
    void pending.then((r) => (settled = r));

    await vi.advanceTimersByTimeAsync(PROVIDER_DNS_LOOKUP_TIMEOUT_MS);

    expect(settled).toBeDefined();
    expect(settled?.size).toBe(0);
    // The same guard as everywhere else, so the same timeout.
    expect(mockLookup).toHaveBeenCalledWith("llm.acme.example", { all: true });
  });
});
