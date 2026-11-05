import { describe, it, expect, afterEach, vi } from "vitest";
import {
  validateExternalUrl,
  resolveExternalUrlTarget,
  isPrivateUrl,
  classifyIpAddress,
  type UrlHostResolver,
} from "../url-validation";

/** Resolver stub: returns the given addresses, never touches real DNS. */
function resolveTo(addresses: string[]): UrlHostResolver {
  return async () => addresses;
}

/** Resolver stub that fails, as `dns.lookup` does for an unresolvable name. */
const unresolvable: UrlHostResolver = async () => {
  throw new Error("ENOTFOUND");
};

/**
 * Runs `validateExternalUrl` and asserts the resolver was never reached.
 *
 * A stub that merely throws does NOT assert this, however it reads: the
 * function's fail-open catch swallows a resolver throw and answers
 * `{ valid: true }`, which is exactly what the bypass path returns too. Proven
 * by canary — with `ALLOW_PRIVATE_URLS` unset, a throwing stub against
 * `http://odoo-mock:8069` still produced `{ valid: true }`, so the earlier
 * version of the bypass test would have stayed green with the bypass deleted.
 * Only a spy can tell "not called" from "called and ignored".
 */
async function validateWithoutDns(urlString: string) {
  const resolver = vi.fn<UrlHostResolver>(async () => {
    throw new Error("resolver must not be called");
  });
  const result = await validateExternalUrl(urlString, resolver);
  expect(resolver).not.toHaveBeenCalled();
  return result;
}

describe("isPrivateUrl", () => {
  it("rejects localhost", () => {
    expect(isPrivateUrl("http://localhost:8069")).toBe(true);
  });

  it("rejects 127.0.0.1 (loopback)", () => {
    expect(isPrivateUrl("http://127.0.0.1:8069")).toBe(true);
  });

  it("rejects 10.x.x.x (class A private)", () => {
    expect(isPrivateUrl("http://10.0.0.1:8069")).toBe(true);
  });

  it("rejects 172.16.x.x (class B private)", () => {
    expect(isPrivateUrl("http://172.16.0.1:8069")).toBe(true);
  });

  it("rejects 172.31.x.x (class B private upper bound)", () => {
    expect(isPrivateUrl("http://172.31.255.255:8069")).toBe(true);
  });

  it("rejects 192.168.x.x (class C private)", () => {
    expect(isPrivateUrl("http://192.168.1.1:8069")).toBe(true);
  });

  it("rejects 169.254.x.x (link-local / AWS metadata)", () => {
    expect(isPrivateUrl("http://169.254.169.254/latest/meta-data/")).toBe(true);
  });

  it("rejects IPv6 loopback [::1]", () => {
    expect(isPrivateUrl("http://[::1]:8069")).toBe(true);
  });

  it("rejects an IPv4-mapped IPv6 loopback", () => {
    // `URL` normalizes this to [::ffff:7f00:1], which no longer looks like a
    // loopback address unless the mapped IPv4 is actually decoded.
    expect(isPrivateUrl("http://[::ffff:127.0.0.1]:8069")).toBe(true);
  });

  it("rejects an IPv4-compatible IPv6 loopback", () => {
    // The deprecated `::a.b.c.d` form. `URL` hands it over as [::7f00:1] —
    // it reads as an ordinary public IPv6 address unless the tail is decoded.
    expect(isPrivateUrl("http://[::127.0.0.1]:8069")).toBe(true);
  });

  it("rejects IPv6 unique local address (fc00::/7)", () => {
    expect(isPrivateUrl("http://[fd12:3456:789a::1]:8069")).toBe(true);
  });

  it("rejects 0.0.0.0", () => {
    expect(isPrivateUrl("http://0.0.0.0:8069")).toBe(true);
  });

  it("accepts public domain", () => {
    expect(isPrivateUrl("https://odoo.example.com")).toBe(false);
  });

  it("accepts odoo.com subdomain", () => {
    expect(isPrivateUrl("https://mycompany.odoo.com")).toBe(false);
  });

  it("accepts public IP with HTTP", () => {
    expect(isPrivateUrl("http://93.184.216.34:8069")).toBe(false);
  });

  it("does not reject 172.32.x.x (outside private range)", () => {
    expect(isPrivateUrl("http://172.32.0.1:8069")).toBe(false);
  });

  it.each(["https://fcbank.example.com", "https://fdservice.example.com", "https://fe80.co"])(
    "accepts %s — a DNS name is not an IPv6 literal just because it starts like one",
    (url) => {
      expect(isPrivateUrl(url)).toBe(false);
    }
  );
});

describe("classifyIpAddress", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.99.42.7", "loopback"],
    ["0.0.0.0", "unspecified"],
    ["0.1.2.3", "unspecified"],
    ["169.254.169.254", "link-local"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.10", "private"],
    ["172.32.0.1", "public"],
    ["93.184.216.34", "public"],
    // Special-purpose ranges -- the shared table also used by web_fetch.
    // CGNAT is "private" so an operator can opt in for a tailnet Odoo, except
    // 100.100.100.200, Alibaba Cloud's metadata endpoint.
    ["100.64.0.1", "private"],
    ["100.127.255.255", "private"],
    ["100.100.100.200", "link-local"],
    // 168.63.129.16, Azure's WireServer / host agent: public-looking, but only
    // reachable from inside an Azure VM, and it hands out extension
    // configuration including certificates. Filed with the metadata
    // endpoints; its neighbours stay public.
    ["168.63.129.16", "link-local"],
    ["168.63.129.15", "public"],
    ["168.63.129.17", "public"],
    ["100.63.255.255", "public"],
    ["100.128.0.1", "public"],
    // 198.18.0.0/15 benchmarking: "private", not "reserved" -- operators number
    // internal networks from it and fake-IP DNS (Clash/Mihomo/Surge) answers
    // with it, so ALLOW_PRIVATE_URLS has to be able to open it.
    ["198.18.0.1", "private"],
    ["192.0.0.1", "reserved"],
    ["192.0.2.1", "reserved"],
    ["198.51.100.7", "reserved"],
    ["203.0.113.50", "reserved"],
    ["224.0.0.1", "reserved"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "reserved"],
  ] as const)("classifies IPv4 %s as %s", (address, expected) => {
    expect(classifyIpAddress(address)).toBe(expected);
  });

  it.each([
    ["::1", "loopback"],
    ["0:0:0:0:0:0:0:1", "loopback"],
    ["::", "unspecified"],
    ["fe80::1", "link-local"],
    // fe80::/10 spans fe80 through febf — a prefix match on "fe80" alone
    // would miss most of it.
    ["feb0::1", "link-local"],
    ["fc00::1", "private"],
    ["fd12:3456:789a::1", "private"],
    // EC2's IPv6 metadata endpoint: inside ULA, but filed as link-local so
    // that opening the private class (ALLOW_PRIVATE_URLS) never opens IMDS.
    ["fd00:ec2::254", "link-local"],
    // The other metadata/credential endpoints inside ULA: EKS Pod Identity,
    // GCP metadata, OCI metadata. Same reasoning as fd00:ec2::254.
    ["fd00:ec2::23", "link-local"],
    ["fd20:ce::254", "link-local"],
    ["fd00:c1::a9fe:a9fe", "link-local"],
    ["2606:4700:4700::1111", "public"],
    // fec0::/10 -- deprecated site-local (RFC 3879), still routed inside many
    // networks. Used to be pinned "public", which asserted the bypass.
    ["fec0::1", "private"],
    ["feff::1", "private"],
    ["fe90::1", "link-local"],
    ["ff02::1", "reserved"],
    ["64:ff9b::7f00:1", "loopback"],
    ["64:ff9b::a9fe:a9fe", "link-local"],
    ["64:ff9b::808:808", "public"],
    // Local-use NAT64 (RFC 8215). Corrected expectation: it is an IPv6-only
    // network's own translator prefix, so ALLOW_PRIVATE_URLS opens it.
    ["64:ff9b:1::a00:5", "private"],
    ["::ffff:100.64.0.1", "private"],
    ["::100.100.100.200", "link-local"],
    // IPv4-mapped addresses carry an IPv4 destination; classify what they
    // actually reach, not the IPv6 wrapper.
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:192.168.1.10", "private"],
    ["::ffff:93.184.216.34", "public"],
    // ::a.b.c.d, the deprecated IPv4-compatible form. ::/96 is reserved, so
    // nothing public lives there — decode the tail rather than wave it past.
    ["::127.0.0.1", "loopback"],
    ["::7f00:1", "loopback"],
    ["::169.254.169.254", "link-local"],
    ["::192.168.1.10", "private"],
  ] as const)("classifies IPv6 %s as %s", (address, expected) => {
    expect(classifyIpAddress(address)).toBe(expected);
  });

  it.each([
    ["imap.example.com"],
    ["localhost"],
    [""],
    ["999.1.1.1"],
    ["1.2.3"],
    ["1.2.3.4.5"],
    ["not:an:address"],
  ])("returns null for %s, which is not an IP literal", (value) => {
    expect(classifyIpAddress(value)).toBeNull();
  });

  it("ignores an IPv6 zone identifier", () => {
    expect(classifyIpAddress("fe80::1%eth0")).toBe("link-local");
  });
});

describe("validateExternalUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects non-HTTP scheme (ftp)", async () => {
    const result = await validateWithoutDns("ftp://odoo.example.com");
    expect(result).toEqual({ valid: false, error: expect.stringContaining("HTTP") });
  });

  it("rejects non-HTTP scheme (file)", async () => {
    const result = await validateWithoutDns("file:///etc/passwd");
    expect(result).toEqual({ valid: false, error: expect.stringContaining("HTTP") });
  });

  it("rejects invalid URL", async () => {
    const result = await validateWithoutDns("not-a-url");
    expect(result).toEqual({ valid: false, error: expect.any(String) });
  });

  it("rejects empty string", async () => {
    const result = await validateWithoutDns("");
    expect(result).toEqual({ valid: false, error: expect.any(String) });
  });

  it("rejects localhost (well-known hostname, no DNS needed)", async () => {
    const result = await validateWithoutDns("http://localhost:8069");
    expect(result).toEqual({ valid: false, error: expect.stringContaining("loopback") });
  });

  it("rejects 127.0.0.1 (IP literal, no DNS needed)", async () => {
    const result = await validateWithoutDns("http://127.0.0.1:8069");
    expect(result).toEqual({ valid: false, error: expect.stringContaining("loopback") });
  });

  it("rejects AWS metadata endpoint (IP literal, no DNS needed)", async () => {
    const result = await validateWithoutDns("http://169.254.169.254/latest/meta-data/");
    expect(result).toEqual({ valid: false, error: expect.stringContaining("link-local") });
  });

  it("rejects an IPv6 loopback literal without handing '[::1]' to the resolver", async () => {
    // `URL.hostname` keeps the brackets, and `dns.lookup("[::1]")` throws — so a
    // literal that reaches the resolver lands in the fail-open catch and is
    // allowed. That is the bug `provider-url-guard.ts` shipped; this pins that
    // this module classifies the literal instead of resolving it.
    const result = await validateWithoutDns("http://[::1]:8069");
    expect(result).toEqual({ valid: false, error: expect.stringContaining("loopback") });
  });

  it("rejects an IPv4-mapped IPv6 metadata literal without touching the resolver", async () => {
    const result = await validateWithoutDns("http://[::ffff:169.254.169.254]/");
    expect(result).toEqual({ valid: false, error: expect.stringContaining("link-local") });
  });

  it("accepts a public IPv6 literal without touching the resolver", async () => {
    // Already fully classified from the string — DNS has nothing to add, and
    // asking it would only reintroduce the bracket problem above.
    const result = await validateWithoutDns("https://[2606:4700:4700::1111]");
    expect(result).toEqual({ valid: true, url: "https://[2606:4700:4700::1111]" });
  });

  it("accepts a public IPv4 literal without touching the resolver", async () => {
    const result = await validateWithoutDns("https://93.184.216.35:8069");
    expect(result).toEqual({ valid: true, url: "https://93.184.216.35:8069" });
  });

  it("names the ALLOW_PRIVATE_URLS opt-out for an RFC-1918 address, and only there", async () => {
    // An on-premise Odoo on 10.x is a legitimate deployment, so that refusal
    // has to say how to allow it. Loopback and cloud metadata never are, so
    // theirs must not suggest an opt-out that is the wrong answer for them.
    const onPrem = await validateWithoutDns("http://10.0.0.5:8069");
    expect(onPrem).toEqual({
      valid: false,
      error: expect.stringContaining("ALLOW_PRIVATE_URLS=1"),
    });

    const metadata = await validateWithoutDns("http://169.254.169.254/");
    expect(metadata).toEqual({ valid: false, error: expect.not.stringContaining("ALLOW_") });
  });

  it("treats CGNAT (Tailscale) like RFC-1918: refused, with the ALLOW_PRIVATE_URLS way out", async () => {
    const literal = await validateWithoutDns("http://100.64.0.7:8069");
    expect(literal).toEqual({
      valid: false,
      error: expect.stringContaining("ALLOW_PRIVATE_URLS=1"),
    });

    const viaDns = await validateExternalUrl(
      "https://odoo.tailnet.example",
      resolveTo(["100.101.102.103"])
    );
    expect(viaDns).toEqual({
      valid: false,
      error: expect.stringContaining("ALLOW_PRIVATE_URLS=1"),
    });
  });

  it("treats 198.18.0.0/15 like RFC-1918: refused, with the ALLOW_PRIVATE_URLS way out", async () => {
    // Benchmarking space that operators reuse internally, and that fake-IP DNS
    // (Clash/Mihomo/Surge) hands out for every name. It used to be refused
    // with no opt-in at all, which left such an install no way to reach Odoo.
    const result = await validateExternalUrl(
      "http://odoo.lan.example:8069",
      resolveTo(["198.18.0.42"])
    );
    expect(result).toEqual({
      valid: false,
      error: expect.stringContaining("ALLOW_PRIVATE_URLS=1"),
    });
  });

  it("allows a CGNAT Odoo when ALLOW_PRIVATE_URLS=1", async () => {
    vi.stubEnv("ALLOW_PRIVATE_URLS", "1");
    const result = await validateWithoutDns("http://100.64.0.7:8069");
    expect(result).toEqual({ valid: true, url: "http://100.64.0.7:8069" });
  });

  it.each([
    "http://100.100.100.200/latest/meta-data/",
    "http://168.63.129.16/machine?comp=goalstate",
    "http://[64:ff9b::a9fe:a9fe]/latest/meta-data/",
    "http://[fd20:ce::254]/computeMetadata/v1/",
    "http://240.0.0.1:8069",
    "http://224.0.0.1:8069",
    "http://[ff02::1]:8069",
  ])("rejects %s with no opt-out suggested, since no Odoo server lives there", async (url) => {
    const result = await validateWithoutDns(url);
    expect(result).toEqual({ valid: false, error: expect.not.stringContaining("ALLOW_") });
  });

  it("treats a local-use NAT64 address (64:ff9b:1::/48) as private: refused, then opened by the flag", async () => {
    // An IPv6-only network whose own translator uses the RFC 8215 prefix: the
    // Odoo server behind it is an ordinary internal host, so the admin opt-in
    // has to be able to reach it.
    const refused = await validateWithoutDns("http://[64:ff9b:1::a00:5]:8069");
    expect(refused).toEqual({
      valid: false,
      error: expect.stringContaining("ALLOW_PRIVATE_URLS=1"),
    });

    vi.stubEnv("ALLOW_PRIVATE_URLS", "1");
    const allowed = await validateWithoutDns("http://[64:ff9b:1::a00:5]:8069");
    expect(allowed).toEqual({ valid: true, url: "http://[64:ff9b:1::a00:5]:8069" });
  });

  /**
   * `ollama.local` is what compose maps to the Docker host (`host-gateway`).
   * It used to be mapped in the OpenClaw container only, so Pinchy — which
   * runs this check — could not resolve it, failed open, and the Odoo plugin
   * in OpenClaw then connected to the Docker host. Both containers now carry
   * the mapping (pinned by scripts/lib/compose-extra-hosts.test.mjs), so the
   * name resolves here to whatever the engine answers for `host-gateway`, and
   * that answer is classified like any other.
   */
  describe("ollama.local, resolved through the host-gateway mapping", () => {
    it("Docker on Linux (172.17.0.1): private — refused, opened by ALLOW_PRIVATE_URLS", async () => {
      const refused = await validateExternalUrl(
        "http://ollama.local:8069",
        resolveTo(["172.17.0.1"])
      );
      expect(refused).toEqual({
        valid: false,
        error: expect.stringContaining("ALLOW_PRIVATE_URLS=1"),
      });

      vi.stubEnv("ALLOW_PRIVATE_URLS", "1");
      const allowed = await validateExternalUrl(
        "http://ollama.local:8069",
        resolveTo(["172.17.0.1"])
      );
      expect(allowed).toEqual({ valid: true, url: "http://ollama.local:8069" });
    });

    it("OrbStack (0.250.250.254): unspecified — refused even with ALLOW_PRIVATE_URLS", async () => {
      vi.stubEnv("ALLOW_PRIVATE_URLS", "1");
      const result = await validateExternalUrl(
        "http://ollama.local:8069",
        resolveTo(["0.250.250.254"])
      );
      expect(result).toEqual({ valid: false, error: expect.not.stringContaining("ALLOW_") });
    });
  });

  it("rejects a name that resolves to Alibaba Cloud metadata (100.100.100.200)", async () => {
    const result = await validateExternalUrl(
      "https://rebind.example.com",
      resolveTo(["100.100.100.200"])
    );
    expect(result).toEqual({ valid: false, error: expect.not.stringContaining("ALLOW_") });
  });

  it("accepts HTTPS public domain (resolves to a public address)", async () => {
    const result = await validateExternalUrl(
      "https://odoo.example.com",
      resolveTo(["93.184.216.35"])
    );
    expect(result).toEqual({ valid: true, url: "https://odoo.example.com" });
  });

  it("accepts HTTPS odoo.com subdomain (resolves to a public address)", async () => {
    const result = await validateExternalUrl(
      "https://mycompany.odoo.com",
      resolveTo(["93.184.216.35"])
    );
    expect(result).toEqual({ valid: true, url: "https://mycompany.odoo.com" });
  });

  it("accepts HTTP for on-prem (resolves to a public address)", async () => {
    const result = await validateExternalUrl(
      "http://odoo.example.com:8069",
      resolveTo(["93.184.216.35"])
    );
    expect(result).toEqual({ valid: true, url: "http://odoo.example.com:8069" });
  });

  it("normalizes trailing slash", async () => {
    const result = await validateExternalUrl(
      "https://odoo.example.com/",
      resolveTo(["93.184.216.35"])
    );
    expect(result).toEqual({ valid: true, url: "https://odoo.example.com" });
  });

  it("strips path for origin-only output", async () => {
    const result = await validateExternalUrl(
      "https://odoo.example.com/web/login",
      resolveTo(["93.184.216.35"])
    );
    expect(result).toEqual({ valid: true, url: "https://odoo.example.com" });
  });

  describe("DNS resolution (the actual SSRF-via-DNS / DNS-rebinding case)", () => {
    it("rejects a hostname that resolves to a private address", async () => {
      // The one blocked case that is a plausible real deployment, so this is
      // also the one whose message has to name the way to allow it.
      const result = await validateExternalUrl(
        "https://internal-odoo.attacker.example",
        resolveTo(["10.0.0.5"])
      );
      expect(result).toEqual({
        valid: false,
        error: expect.stringContaining("ALLOW_PRIVATE_URLS=1"),
      });
    });

    it("rejects a hostname that resolves to the cloud-metadata address", async () => {
      const result = await validateExternalUrl(
        "https://metadata.attacker.example",
        resolveTo(["169.254.169.254"])
      );
      expect(result).toEqual({ valid: false, error: expect.stringContaining("link-local") });
    });

    it("rejects a hostname that resolves to loopback", async () => {
      const result = await validateExternalUrl(
        "https://rebind.attacker.example",
        resolveTo(["127.0.0.1"])
      );
      expect(result).toEqual({ valid: false, error: expect.stringContaining("loopback") });
    });

    it("rejects a hostname where only one of several resolved addresses is private", async () => {
      // A resolver can legitimately return multiple A/AAAA records; every one
      // of them must be classified, not just the first.
      const result = await validateExternalUrl(
        "https://mixed.attacker.example",
        resolveTo(["93.184.216.35", "127.0.0.1"])
      );
      expect(result).toEqual({ valid: false, error: expect.stringContaining("loopback") });
    });

    it("rejects a hostname that resolves to an IPv4-mapped IPv6 metadata address", async () => {
      const result = await validateExternalUrl(
        "https://mapped.attacker.example",
        resolveTo(["::ffff:169.254.169.254"])
      );
      expect(result).toEqual({ valid: false, error: expect.stringContaining("link-local") });
    });

    it("allows a hostname that resolves only to public addresses", async () => {
      const result = await validateExternalUrl(
        "https://real-odoo.example",
        resolveTo(["93.184.216.35", "2606:4700:4700::1111"])
      );
      expect(result).toEqual({ valid: true, url: "https://real-odoo.example" });
    });

    it("fails open when the hostname does not resolve at all (typo, not an attack)", async () => {
      const result = await validateExternalUrl("https://typo.example", unresolvable);
      expect(result).toEqual({ valid: true, url: "https://typo.example" });
    });
  });

  /**
   * `ALLOW_PRIVATE_URLS=1` opens the `private` class and nothing else — the
   * same two tiers as `ALLOW_PRIVATE_MAIL_HOSTS`. It used to switch the whole
   * check off, and the upgrade note for CGNAT tells every Tailscale-Odoo
   * install to set it: an admin who can add an Odoo connection would then reach
   * 127.0.0.1, the cloud-metadata services and the OpenClaw gateway.
   */
  describe("ALLOW_PRIVATE_URLS opens the private class only", () => {
    it("allows a private address literal when ALLOW_PRIVATE_URLS=1", async () => {
      vi.stubEnv("ALLOW_PRIVATE_URLS", "1");
      const result = await validateWithoutDns("http://10.0.0.5:8069");
      expect(result).toEqual({ valid: true, url: "http://10.0.0.5:8069" });
    });

    it("allows internal Docker hostnames that resolve to a private address", async () => {
      vi.stubEnv("ALLOW_PRIVATE_URLS", "1");
      // odoo-e2e / eval stacks set this flag so the wizard can reach odoo-mock
      // on the Docker-internal network. Docker's embedded DNS answers with the
      // container's bridge address, which is private — so the name is still
      // resolved and classified, and passes because of the flag, not around it.
      const resolver = vi.fn<UrlHostResolver>(async () => ["172.18.0.5"]);
      const result = await validateExternalUrl("http://odoo-mock:8069", resolver);
      expect(resolver).toHaveBeenCalledWith("odoo-mock");
      expect(result).toEqual({ valid: true, url: "http://odoo-mock:8069" });
    });

    it.each([
      "http://100.64.0.7:8069",
      "http://192.168.1.20:8069",
      "http://[fd12:3456:789a::1]:8069",
      "http://198.18.0.10:8069",
    ])("allows the private literal %s when ALLOW_PRIVATE_URLS=1", async (url) => {
      vi.stubEnv("ALLOW_PRIVATE_URLS", "1");
      const result = await validateWithoutDns(url);
      expect(result).toEqual({ valid: true, url: new URL(url).origin });
    });

    it.each([
      "http://localhost:8069",
      "http://127.0.0.1:8069",
      "http://[::1]:8069",
      "http://0.0.0.0:8069",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.100.100.200/latest/meta-data/",
      "http://168.63.129.16/machine?comp=goalstate",
      "http://[fd00:ec2::254]/latest/meta-data/",
      "http://[::ffff:127.0.0.1]:8069",
      "http://[64:ff9b::a9fe:a9fe]/",
      "http://[fd00:ec2::23]/v1/credentials",
      "http://[fd20:ce::254]/computeMetadata/v1/",
      "http://[fd00:c1::a9fe:a9fe]/opc/v2/instance/",
      "http://[fd00:c1::169.254.169.254]/opc/v2/instance/",
      "http://240.0.0.1:8069",
      "http://224.0.0.1:8069",
    ])("still refuses %s with ALLOW_PRIVATE_URLS=1", async (url) => {
      vi.stubEnv("ALLOW_PRIVATE_URLS", "1");
      const result = await validateWithoutDns(url);
      // And the refusal does not suggest the flag the operator already set.
      expect(result).toEqual({ valid: false, error: expect.not.stringContaining("ALLOW_") });
    });

    it.each([
      ["127.0.0.1"],
      ["169.254.169.254"],
      ["100.100.100.200"],
      ["fd00:ec2::254"],
      ["fd00:ec2::23"],
      ["fd20:ce::254"],
      ["fd00:c1::a9fe:a9fe"],
    ])("still refuses a name that resolves to %s with ALLOW_PRIVATE_URLS=1", async (address) => {
      vi.stubEnv("ALLOW_PRIVATE_URLS", "1");
      const result = await validateExternalUrl(
        "http://odoo.rebind.example:8069",
        resolveTo(["10.0.0.5", address])
      );
      expect(result).toEqual({ valid: false, error: expect.not.stringContaining("ALLOW_") });
    });

    it("still fails open for an unresolvable name with ALLOW_PRIVATE_URLS=1", async () => {
      vi.stubEnv("ALLOW_PRIVATE_URLS", "1");
      const result = await validateExternalUrl("http://typo-odoo:8069", unresolvable);
      expect(result).toEqual({ valid: true, url: "http://typo-odoo:8069" });
    });

    it("still rejects non-HTTP schemes even with ALLOW_PRIVATE_URLS=1", async () => {
      vi.stubEnv("ALLOW_PRIVATE_URLS", "1");
      const result = await validateWithoutDns("ftp://localhost:8069");
      expect(result).toEqual({ valid: false, error: expect.stringContaining("HTTP") });
    });

    it("still rejects invalid URLs even with ALLOW_PRIVATE_URLS=1", async () => {
      vi.stubEnv("ALLOW_PRIVATE_URLS", "1");
      const result = await validateWithoutDns("not-a-url");
      expect(result).toEqual({ valid: false, error: expect.any(String) });
    });
  });
});

describe("resolveExternalUrlTarget", () => {
  // The variant for a caller that connects: it returns the address it
  // classified so the request can be pinned to it, and a name with no answer
  // is refused — one lookup, so nothing later gets to resolve it again.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the origin and the address it classified", async () => {
    await expect(
      resolveExternalUrlTarget("https://odoo.example.com/web", resolveTo(["93.184.216.34"]))
    ).resolves.toEqual({
      valid: true,
      url: "https://odoo.example.com",
      target: { address: "93.184.216.34", family: 4 },
    });
  });

  it("pins an address literal to itself without asking the resolver", async () => {
    const resolver = vi.fn<UrlHostResolver>(async () => ["93.184.216.34"]);

    await expect(
      resolveExternalUrlTarget("http://[2606:2800:220:1::1]:8069", resolver)
    ).resolves.toEqual({
      valid: true,
      url: "http://[2606:2800:220:1::1]:8069",
      target: { address: "2606:2800:220:1::1", family: 6 },
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("refuses a name whose lookup fails, instead of failing open", async () => {
    await expect(
      resolveExternalUrlTarget("https://typo-odoo.example.com", unresolvable)
    ).resolves.toEqual({ valid: false, error: expect.stringContaining("resolve") });
  });

  it("refuses a name that resolves to nothing", async () => {
    await expect(
      resolveExternalUrlTarget("https://empty.example.com", resolveTo([]))
    ).resolves.toEqual({ valid: false, error: expect.stringContaining("resolve") });
  });

  it("still refuses what validateExternalUrl refuses", async () => {
    await expect(
      resolveExternalUrlTarget(
        "https://odoo.example.com",
        resolveTo(["93.184.216.34", "127.0.0.1"])
      )
    ).resolves.toMatchObject({ valid: false });
    await expect(
      resolveExternalUrlTarget("https://odoo.example.com", resolveTo(["10.0.0.5"]))
    ).resolves.toEqual({ valid: false, error: expect.stringContaining("ALLOW_PRIVATE_URLS") });
    await expect(
      resolveExternalUrlTarget("ftp://odoo.example.com", resolveTo([]))
    ).resolves.toMatchObject({ valid: false });
  });

  it("allows a private address with ALLOW_PRIVATE_URLS=1, pinned", async () => {
    vi.stubEnv("ALLOW_PRIVATE_URLS", "1");

    await expect(
      resolveExternalUrlTarget("http://odoo-mock:8069", resolveTo(["172.18.0.4"]))
    ).resolves.toEqual({
      valid: true,
      url: "http://odoo-mock:8069",
      target: { address: "172.18.0.4", family: 4 },
    });
  });
});
