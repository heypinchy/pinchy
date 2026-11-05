import { describe, it, expect, afterEach, vi } from "vitest";
import {
  classifyIp,
  assertAllowedProviderUrl,
  memoizeResolver,
  ProviderUrlBlockedError,
  ProviderUrlUnresolvableError,
  resolveAllowedProviderTarget,
  PROVIDER_DNS_LOOKUP_TIMEOUT_MS,
  resolveHostAddresses,
} from "@/lib/provider-url-guard";

// Only the default-resolver tests at the bottom reach this; every other test
// injects its resolver. No test here touches real DNS.
const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));
vi.mock("dns/promises", () => ({ default: { lookup: mockLookup }, lookup: mockLookup }));

describe("classifyIp", () => {
  it.each([
    // Always-blocked IPv4
    ["169.254.169.254", "blocked"], // cloud metadata (IMDS) — the headline case
    ["169.254.0.1", "blocked"],
    ["127.0.0.1", "blocked"],
    ["127.9.9.9", "blocked"],
    ["0.0.0.0", "blocked"],
    ["224.0.0.1", "blocked"], // multicast
    ["240.0.0.1", "blocked"], // reserved
    ["255.255.255.255", "blocked"], // broadcast
    // Private IPv4 (env-gated)
    ["10.0.0.5", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "private"], // CGNAT
    // Public IPv4 — including the edges just outside the private blocks
    ["8.8.8.8", "public"],
    ["1.1.1.1", "public"],
    ["172.15.0.1", "public"],
    ["172.32.0.1", "public"],
    ["100.63.255.255", "public"],
    // IPv6
    ["::1", "blocked"], // loopback
    ["::", "blocked"], // unspecified
    ["fe80::1", "blocked"], // link-local
    ["febf::1", "blocked"], // link-local upper edge
    ["ff02::1", "blocked"], // multicast
    ["fc00::1", "private"], // ULA
    ["fd12:3456:789a::1", "private"], // ULA
    ["2606:4700:4700::1111", "public"], // public v6 (Cloudflare)
    // IPv4-mapped IPv6 must classify by the embedded v4 (bypass guard)
    ["::ffff:169.254.169.254", "blocked"],
    ["::ffff:127.0.0.1", "blocked"],
    ["::ffff:10.0.0.1", "private"],
    ["::ffff:8.8.8.8", "public"],
    // The shared table (pinchy-web/ip-address.ts). This guard kept its own list
    // and it had the same holes the others had: a cloud-metadata address inside
    // a "private" range read as an ordinary LAN host, allowed by default, and
    // the IPv6 forms that carry an IPv4 address were taken at face value.
    ["100.100.100.200", "blocked"], // Alibaba Cloud metadata, inside CGNAT
    // Azure WireServer: a public-looking address the old list let straight
    // through, reachable only from inside an Azure VM.
    ["168.63.129.16", "blocked"],
    ["168.63.129.17", "public"],
    ["fd00:ec2::254", "blocked"], // EC2 IPv6 metadata, inside ULA
    ["fd00:ec2::23", "blocked"], // EKS Pod Identity Agent, inside ULA
    ["fd20:ce::254", "blocked"], // GCP IPv6 metadata, inside ULA
    ["fd00:c1::a9fe:a9fe", "blocked"], // OCI IPv6 metadata, inside ULA
    ["64:ff9b::a9fe:a9fe", "blocked"], // NAT64 -> 169.254.169.254
    ["64:ff9b::7f00:1", "blocked"], // NAT64 -> 127.0.0.1
    ["2002:a9fe:a9fe::1", "blocked"], // 6to4 -> 169.254.169.254
    ["2001:0:a9fe:a9fe::1", "blocked"], // Teredo
    ["::ffff:0:7f00:1", "blocked"], // SIIT IPv4-translated
    // benchmarking 198.18/15: private, not blocked -- operators reuse it
    // internally and fake-IP DNS (Clash/Mihomo/Surge) hands it out.
    ["198.18.0.1", "private"],
    ["192.0.2.1", "blocked"], // TEST-NET-1
    ["2001:db8::1", "blocked"], // documentation
    // ...while a self-hosted endpoint on the LAN or a tailnet keeps working.
    ["100.100.100.100", "private"], // Tailscale node
    ["64:ff9b::a00:5", "private"], // NAT64 -> 10.0.0.5
    // Local-use NAT64 (RFC 8215): an IPv6-only network's own translator, so a
    // LAN endpoint behind it — allowed by default like any private address.
    ["64:ff9b:1::a00:5", "private"],
    ["fec0::1", "private"], // deprecated site-local
  ])("classifies %s as %s", (ip, expected) => {
    expect(classifyIp(ip)).toBe(expected);
  });

  it("treats non-IP input as blocked (defensive)", () => {
    expect(classifyIp("not-an-ip")).toBe("blocked");
  });
});

describe("assertAllowedProviderUrl", () => {
  const resolveTo = (addrs: string[]) => async () => addrs;

  afterEach(() => {
    delete process.env.PINCHY_PROVIDER_BLOCK_PRIVATE_NETWORKS;
  });

  it("rejects non-http(s) schemes (file://)", async () => {
    await expect(
      assertAllowedProviderUrl("file:///etc/passwd", resolveTo([]))
    ).rejects.toMatchObject({ reason: "unsupported_scheme" });
  });

  it("rejects gopher:// and other schemes", async () => {
    await expect(
      assertAllowedProviderUrl("gopher://example.com/", resolveTo(["1.2.3.4"]))
    ).rejects.toBeInstanceOf(ProviderUrlBlockedError);
  });

  it("blocks a hostname that resolves to the cloud metadata IP", async () => {
    await expect(
      assertAllowedProviderUrl("http://metadata.evil.example/v1", resolveTo(["169.254.169.254"]))
    ).rejects.toMatchObject({ reason: "blocked_address" });
  });

  it("blocks when ANY resolved address is dangerous (dual-record host)", async () => {
    await expect(
      assertAllowedProviderUrl(
        "https://mixed.example/v1",
        resolveTo(["93.184.216.34", "127.0.0.1"])
      )
    ).rejects.toMatchObject({ reason: "blocked_address" });
  });

  it("allows a public endpoint", async () => {
    await expect(
      assertAllowedProviderUrl("https://api.together.xyz/v1", resolveTo(["1.2.3.4"]))
    ).resolves.toBeUndefined();
  });

  it("allows a private LAN endpoint by default (self-hosted vLLM/TGI)", async () => {
    await expect(
      assertAllowedProviderUrl("http://vllm.lan:8000/v1", resolveTo(["10.0.0.5"]))
    ).resolves.toBeUndefined();
  });

  it("blocks a private LAN endpoint when the deployment opts in", async () => {
    process.env.PINCHY_PROVIDER_BLOCK_PRIVATE_NETWORKS = "1";
    await expect(
      assertAllowedProviderUrl("http://vllm.lan:8000/v1", resolveTo(["10.0.0.5"]))
    ).rejects.toMatchObject({ reason: "private_address" });
  });

  it("fails open when DNS resolution throws (temporarily unreachable host)", async () => {
    const throwingResolver = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(
      assertAllowedProviderUrl("https://maybe-down.example/v1", throwingResolver)
    ).resolves.toBeUndefined();
  });

  it("blocks an IP-literal metadata URL without needing DNS", async () => {
    // Resolver returns the literal (mirrors dns.lookup short-circuiting IP literals).
    await expect(
      assertAllowedProviderUrl(
        "http://169.254.169.254/latest/meta-data/",
        resolveTo(["169.254.169.254"])
      )
    ).rejects.toMatchObject({ reason: "blocked_address" });
  });
});

/**
 * An address literal must never reach the resolver.
 *
 * `new URL("http://[::1]/v1").hostname` is `"[::1]"` — WITH the brackets. That
 * string is not an IP as far as `isIP()` is concerned, and `dns.lookup()`
 * rejects it, so it landed in the `catch { return }` that fails open for
 * temporarily-unreachable hosts. Every branch of `classifyIpv6` was therefore
 * unreachable from URL input: the whole IPv6 half of the guard was dead code,
 * `PINCHY_PROVIDER_BLOCK_PRIVATE_NETWORKS=1` did nothing for ULA, and IMDS was
 * one `::ffff:` prefix away.
 *
 * The existing suite could not see it, because `resolveTo([...])` answers any
 * host including a bracketed one. These cases use a resolver that throws the
 * way the real one does — so a literal only passes if the guard classified it
 * WITHOUT DNS, which is the actual claim.
 */
describe("assertAllowedProviderUrl — address literals bypass DNS", () => {
  /** Behaves like dns.lookup on input that is not a resolvable name. */
  const unresolvable = async () => {
    throw new Error("ENOTFOUND");
  };

  afterEach(() => {
    delete process.env.PINCHY_PROVIDER_BLOCK_PRIVATE_NETWORKS;
  });

  it.each([
    ["Alibaba Cloud metadata", "http://100.100.100.200/latest/meta-data/"],
    ["Azure WireServer", "http://168.63.129.16/machine?comp=goalstate"],
    ["EC2 IPv6 metadata", "http://[fd00:ec2::254]/latest/meta-data/"],
    ["EKS Pod Identity Agent", "http://[fd00:ec2::23]/v1/credentials"],
    ["GCP IPv6 metadata", "http://[fd20:ce::254]/computeMetadata/v1/"],
    ["OCI IPv6 metadata", "http://[fd00:c1::a9fe:a9fe]/opc/v2/instance/"],
    ["IMDS through NAT64", "http://[64:ff9b::a9fe:a9fe]/latest/"],
    ["IMDS through 6to4", "http://[2002:a9fe:a9fe::]/latest/"],
    ["IPv6 loopback", "http://[::1]/v1"],
    ["IPv6 unspecified", "http://[::]/v1"],
    ["IPv6 link-local", "http://[fe80::1]/v1"],
    ["IMDS through an IPv4-mapped IPv6 literal", "http://[::ffff:169.254.169.254]/latest/"],
    ["loopback through an IPv4-mapped IPv6 literal", "http://[::ffff:127.0.0.1]/v1"],
    ["IPv4 loopback", "http://127.0.0.1/v1"],
    ["IMDS as a bare IPv4 literal", "http://169.254.169.254/latest/meta-data/"],
  ])("blocks %s", async (_label, url) => {
    await expect(assertAllowedProviderUrl(url, unresolvable)).rejects.toMatchObject({
      reason: "blocked_address",
    });
  });

  it("refuses a zone-id link-local host at the URL parse step", async () => {
    // `http://[fe80::1%eth0]/` is not a valid URL to the WHATWG parser, so it
    // never reaches address classification. Pinned because it is the reason
    // the literal path needs no zone-id handling of its own.
    await expect(
      assertAllowedProviderUrl("http://[fe80::1%25eth0]/v1", unresolvable)
    ).rejects.toMatchObject({ reason: "unsupported_scheme" });
  });

  it("refuses a bracketed host that is not a parseable address", async () => {
    await expect(
      assertAllowedProviderUrl("http://[not-an-address]/v1", unresolvable)
    ).rejects.toBeInstanceOf(ProviderUrlBlockedError);
  });

  it("blocks a ULA literal when the deployment opts out of private networks", async () => {
    // The documented lockdown for the hosted topology. It was a no-op for
    // every IPv6 literal.
    process.env.PINCHY_PROVIDER_BLOCK_PRIVATE_NETWORKS = "1";
    await expect(
      assertAllowedProviderUrl("http://[fd00::1]/v1", unresolvable)
    ).rejects.toMatchObject({ reason: "private_address" });
  });

  it("still allows a ULA literal by default, so self-hosted IPv6 LANs keep working", async () => {
    await expect(
      assertAllowedProviderUrl("http://[fd00::1]:8000/v1", unresolvable)
    ).resolves.toBeUndefined();
  });

  it("allows a public IPv6 literal", async () => {
    await expect(
      assertAllowedProviderUrl("https://[2606:4700:4700::1111]/v1", unresolvable)
    ).resolves.toBeUndefined();
  });

  it("still fails open for a genuine name that does not resolve", async () => {
    // The documented trade-off stays: only LITERALS stop depending on DNS.
    await expect(
      assertAllowedProviderUrl("https://maybe-down.example/v1", unresolvable)
    ).resolves.toBeUndefined();
  });
});

describe("the default resolver's lookup budget", () => {
  // The guard sits in front of request paths (the settings page's provider
  // list, every config regenerate, every model probe). A resolver that never
  // answers must not hold any of them: after the budget the lookup counts as
  // failed, which the guard treats like any other unresolvable name.
  afterEach(() => {
    vi.useRealTimers();
    mockLookup.mockReset();
  });

  it("gives up after PROVIDER_DNS_LOOKUP_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    mockLookup.mockImplementation(() => new Promise(() => {}));

    const lookup = resolveHostAddresses("llm.acme.example");
    const outcome = lookup.then(
      () => "answered",
      () => "gave up"
    );

    await vi.advanceTimersByTimeAsync(PROVIDER_DNS_LOOKUP_TIMEOUT_MS - 1);
    expect(await Promise.race([outcome, Promise.resolve("waiting")])).toBe("waiting");
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe("gave up");
  });

  it("is a few seconds, not the resolver's own (much longer) retry schedule", () => {
    expect(PROVIDER_DNS_LOOKUP_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
    expect(PROVIDER_DNS_LOOKUP_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });

  it("lets the URL through when the lookup times out (fail open, like an unresolvable name)", async () => {
    vi.useFakeTimers();
    mockLookup.mockImplementation(() => new Promise(() => {}));

    const verdict = assertAllowedProviderUrl("https://llm.acme.example/v1").then(
      () => "allowed",
      () => "refused"
    );
    await vi.advanceTimersByTimeAsync(PROVIDER_DNS_LOOKUP_TIMEOUT_MS);

    expect(await verdict).toBe("allowed");
  });

  it("returns every address a name resolves to", async () => {
    mockLookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1::1", family: 6 },
    ]);

    expect(await resolveHostAddresses("llm.acme.example")).toEqual([
      "93.184.216.34",
      "2606:2800:220:1::1",
    ]);
  });
});

describe("memoizeResolver", () => {
  it("asks the underlying resolver once per host, failures included", async () => {
    const base = vi.fn(async (host: string) => {
      if (host === "down.example") throw new Error("ENOTFOUND");
      return ["93.184.216.34"];
    });
    const resolver = memoizeResolver(base);

    expect(await resolver("a.example")).toEqual(["93.184.216.34"]);
    expect(await resolver("a.example")).toEqual(["93.184.216.34"]);
    await expect(resolver("down.example")).rejects.toThrow("ENOTFOUND");
    await expect(resolver("down.example")).rejects.toThrow("ENOTFOUND");

    expect(base).toHaveBeenCalledTimes(2);
  });
});

describe("resolveAllowedProviderTarget", () => {
  // The variant for callers that connect: it hands back the address it
  // classified, so the connection can be pinned to it, and it does not fail
  // open — with one resolution there is no later fetch to "fail naturally".
  const resolveTo = (addrs: string[]) => async () => addrs;

  afterEach(() => {
    delete process.env.PINCHY_PROVIDER_BLOCK_PRIVATE_NETWORKS;
  });

  it("returns the address it classified", async () => {
    await expect(
      resolveAllowedProviderTarget("https://api.together.xyz/v1", resolveTo(["93.184.216.34"]))
    ).resolves.toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("returns an IPv6 answer with its family", async () => {
    await expect(
      resolveAllowedProviderTarget("https://v6.example/v1", resolveTo(["2606:2800:220:1::1"]))
    ).resolves.toEqual({ address: "2606:2800:220:1::1", family: 6 });
  });

  it("returns an address literal as itself, asking no resolver", async () => {
    const resolver = vi.fn(async () => ["93.184.216.34"]);

    await expect(
      resolveAllowedProviderTarget("http://[fd00::5]:8000/v1", resolver)
    ).resolves.toEqual({ address: "fd00::5", family: 6 });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("refuses a name whose lookup fails, instead of failing open", async () => {
    const throwingResolver = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    };

    await expect(
      resolveAllowedProviderTarget("https://maybe-down.example/v1", throwingResolver)
    ).rejects.toBeInstanceOf(ProviderUrlUnresolvableError);
  });

  it("refuses a name that resolves to nothing", async () => {
    await expect(
      resolveAllowedProviderTarget("https://empty.example/v1", resolveTo([]))
    ).rejects.toBeInstanceOf(ProviderUrlUnresolvableError);
  });

  it("still refuses what the assertion refuses", async () => {
    await expect(
      resolveAllowedProviderTarget(
        "https://mixed.example/v1",
        resolveTo(["93.184.216.34", "127.0.0.1"])
      )
    ).rejects.toMatchObject({ reason: "blocked_address" });
    process.env.PINCHY_PROVIDER_BLOCK_PRIVATE_NETWORKS = "1";
    await expect(
      resolveAllowedProviderTarget("http://vllm.lan:8000/v1", resolveTo(["10.0.0.5"]))
    ).rejects.toMatchObject({ reason: "private_address" });
    await expect(
      resolveAllowedProviderTarget("file:///etc/passwd", resolveTo([]))
    ).rejects.toMatchObject({ reason: "unsupported_scheme" });
  });
});
