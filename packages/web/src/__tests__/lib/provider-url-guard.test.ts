import { describe, it, expect, afterEach } from "vitest";
import {
  classifyIp,
  assertAllowedProviderUrl,
  ProviderUrlBlockedError,
} from "@/lib/provider-url-guard";

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
      assertAllowedProviderUrl("https://mixed.example/v1", resolveTo(["203.0.113.10", "127.0.0.1"]))
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
