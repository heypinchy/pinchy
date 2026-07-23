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
