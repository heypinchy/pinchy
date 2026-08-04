import { describe, it, expect, afterEach, vi } from "vitest";
import {
  validateExternalUrl,
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
    expect(isPrivateUrl("http://203.0.113.50:8069")).toBe(false);
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
    ["203.0.113.50", "public"],
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
    ["fd00:ec2::254", "private"],
    ["2606:4700:4700::1111", "public"],
    ["fec0::1", "public"],
    // IPv4-mapped addresses carry an IPv4 destination; classify what they
    // actually reach, not the IPv6 wrapper.
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:192.168.1.10", "private"],
    ["::ffff:203.0.113.50", "public"],
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
    const result = await validateWithoutDns("https://203.0.113.10:8069");
    expect(result).toEqual({ valid: true, url: "https://203.0.113.10:8069" });
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

  it("accepts HTTPS public domain (resolves to a public address)", async () => {
    const result = await validateExternalUrl(
      "https://odoo.example.com",
      resolveTo(["203.0.113.10"])
    );
    expect(result).toEqual({ valid: true, url: "https://odoo.example.com" });
  });

  it("accepts HTTPS odoo.com subdomain (resolves to a public address)", async () => {
    const result = await validateExternalUrl(
      "https://mycompany.odoo.com",
      resolveTo(["203.0.113.10"])
    );
    expect(result).toEqual({ valid: true, url: "https://mycompany.odoo.com" });
  });

  it("accepts HTTP for on-prem (resolves to a public address)", async () => {
    const result = await validateExternalUrl(
      "http://odoo.example.com:8069",
      resolveTo(["203.0.113.10"])
    );
    expect(result).toEqual({ valid: true, url: "http://odoo.example.com:8069" });
  });

  it("normalizes trailing slash", async () => {
    const result = await validateExternalUrl(
      "https://odoo.example.com/",
      resolveTo(["203.0.113.10"])
    );
    expect(result).toEqual({ valid: true, url: "https://odoo.example.com" });
  });

  it("strips path for origin-only output", async () => {
    const result = await validateExternalUrl(
      "https://odoo.example.com/web/login",
      resolveTo(["203.0.113.10"])
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
        resolveTo(["203.0.113.10", "127.0.0.1"])
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
        resolveTo(["203.0.113.10", "2606:4700:4700::1111"])
      );
      expect(result).toEqual({ valid: true, url: "https://real-odoo.example" });
    });

    it("fails open when the hostname does not resolve at all (typo, not an attack)", async () => {
      const result = await validateExternalUrl("https://typo.example", unresolvable);
      expect(result).toEqual({ valid: true, url: "https://typo.example" });
    });
  });

  describe("ALLOW_PRIVATE_URLS bypass", () => {
    it("allows private URLs when ALLOW_PRIVATE_URLS=1", async () => {
      vi.stubEnv("ALLOW_PRIVATE_URLS", "1");
      const result = await validateWithoutDns("http://localhost:8069");
      expect(result).toEqual({ valid: true, url: "http://localhost:8069" });
    });

    it("allows internal Docker hostnames when ALLOW_PRIVATE_URLS=1, without touching DNS", async () => {
      vi.stubEnv("ALLOW_PRIVATE_URLS", "1");
      // odoo-e2e / eval stacks set this flag so the wizard can reach odoo-mock
      // on the Docker-internal network, where there is no resolver answer to
      // be had. `validateWithoutDns` fails if the bypass ever stops
      // short-circuiting: a bare name like this one would otherwise be handed
      // to DNS, and the resulting failure is silently allowed.
      const result = await validateWithoutDns("http://odoo-mock:8069");
      expect(result).toEqual({ valid: true, url: "http://odoo-mock:8069" });
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
