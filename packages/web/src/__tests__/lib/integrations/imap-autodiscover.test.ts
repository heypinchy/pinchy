import { describe, it, expect, vi } from "vitest";
import {
  isSafeAutodiscoverUrl,
  discoverViaSrv,
  autodiscover,
  type SrvResolver,
} from "@/lib/integrations/imap-autodiscover";
import { lookupProviderTable, lookupProviderByMx } from "@/lib/integrations/imap-providers";

describe("isSafeAutodiscoverUrl", () => {
  it.each([
    ["http://autoconfig.example.com", "http instead of https"],
    ["https://127.0.0.1/x", "IPv4 loopback"],
    ["https://[::1]/x", "IPv6 loopback literal"],
    ["https://169.254.169.254/x", "cloud metadata IP"],
    ["https://foo.local/x", ".local TLD"],
    ["https://localhost/x", "localhost hostname"],
    ["https://10.0.0.5/x", "RFC1918 10.x"],
    ["https://192.168.1.1/x", "RFC1918 192.168.x"],
    ["not a url", "malformed URL"],
    ["https://localhost./x", "localhost with trailing FQDN dot"],
    ["https://metadata.google.internal./x", "metadata hostname with trailing FQDN dot"],
    ["https://foo.internal./x", ".internal suffix with trailing FQDN dot"],
    ["https://foo.local./x", ".local suffix with trailing FQDN dot"],
    ["https://LOCALHOST./x", "uppercase localhost with trailing FQDN dot"],
    ["https://2130706433/", "decimal integer literal for 127.0.0.1"],
    ["https://0x7f000001/", "hex integer literal for 127.0.0.1"],
    ["https://0177.0.0.1/", "octal dotted literal for 127.0.0.1"],
    ["https://[::1]/", "bracketed IPv6 loopback literal"],
  ])("rejects %s (%s)", (url) => {
    expect(isSafeAutodiscoverUrl(url)).toBe(false);
  });

  it("rejects metadata.google.internal", () => {
    expect(isSafeAutodiscoverUrl("https://metadata.google.internal/x")).toBe(false);
  });

  it("rejects hosts ending in .internal", () => {
    expect(isSafeAutodiscoverUrl("https://svc.internal/x")).toBe(false);
  });

  it("rejects hosts ending in .localhost", () => {
    expect(isSafeAutodiscoverUrl("https://foo.localhost/x")).toBe(false);
  });

  it("accepts a well-formed public https autoconfig URL", () => {
    expect(isSafeAutodiscoverUrl("https://autoconfig.example.com/mail/config-v1.1.xml")).toBe(true);
  });

  it("accepts a bare public https autoconfig host", () => {
    expect(isSafeAutodiscoverUrl("https://autoconfig.example.com/")).toBe(true);
  });
});

describe("lookupProviderTable", () => {
  it("returns the correct config for a known domain (gmail.com)", () => {
    const result = lookupProviderTable("gmail.com");
    expect(result).toEqual({
      imapHost: "imap.gmail.com",
      imapPort: 993,
      smtpHost: "smtp.gmail.com",
      smtpPort: 587,
      security: "tls",
    });
  });

  it("returns null for an unknown domain", () => {
    expect(lookupProviderTable("some-random-domain-that-does-not-exist.example")).toBeNull();
  });

  it("is case-insensitive", () => {
    const lower = lookupProviderTable("gmail.com");
    const upper = lookupProviderTable("GMAIL.COM");
    expect(upper).toEqual(lower);
  });

  it.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
    "returns null for prototype-chain key %s instead of a truthy prototype value",
    (key) => {
      expect(lookupProviderTable(key)).toBeNull();
    }
  );
});

describe("lookupProviderByMx", () => {
  it("returns the Migadu config for an aspmx1.migadu.com MX host", () => {
    expect(lookupProviderByMx(["aspmx1.migadu.com"])).toEqual({
      imapHost: "imap.migadu.com",
      imapPort: 993,
      smtpHost: "smtp.migadu.com",
      smtpPort: 465,
      security: "tls",
    });
  });

  it("matches case-insensitively and strips a trailing FQDN dot (ASPMX.L.GOOGLE.COM.)", () => {
    expect(lookupProviderByMx(["ASPMX.L.GOOGLE.COM."])).toEqual({
      imapHost: "imap.gmail.com",
      imapPort: 993,
      smtpHost: "smtp.gmail.com",
      smtpPort: 587,
      security: "tls",
    });
  });

  it("does NOT match a suffix without a dot boundary (evilmigadu.com must not match migadu.com)", () => {
    expect(lookupProviderByMx(["evilmigadu.com"])).toBeNull();
  });

  it("returns null for an unknown MX host", () => {
    expect(lookupProviderByMx(["mx.unknown-host.example"])).toBeNull();
  });

  it("returns null for an empty array", () => {
    expect(lookupProviderByMx([])).toBeNull();
  });

  it("matches Fastmail's messagingengine.com MX suffix", () => {
    expect(lookupProviderByMx(["in1-smtp.messagingengine.com"])).toEqual({
      imapHost: "imap.fastmail.com",
      imapPort: 993,
      smtpHost: "smtp.fastmail.com",
      smtpPort: 587,
      security: "tls",
    });
  });

  it("matches Outlook/Office365's mail.protection.outlook.com MX suffix", () => {
    expect(lookupProviderByMx(["contoso-com.mail.protection.outlook.com"])).toEqual({
      imapHost: "outlook.office365.com",
      imapPort: 993,
      smtpHost: "smtp.office365.com",
      smtpPort: 587,
      security: "tls",
    });
  });
});

function makeResolver(impl: SrvResolver["resolveSrv"]): SrvResolver {
  return { resolveSrv: impl };
}

describe("discoverViaSrv", () => {
  it("resolves imap host/port and smtp host/port from SRV records", async () => {
    const resolver = makeResolver(async (name: string) => {
      if (name === "_imaps._tcp.example.com") {
        return [{ name: "imap.example.com", port: 993, priority: 10, weight: 0 }];
      }
      if (name === "_submission._tcp.example.com") {
        return [{ name: "smtp.example.com", port: 587, priority: 10, weight: 0 }];
      }
      throw new Error("unexpected lookup");
    });

    const result = await discoverViaSrv("example.com", resolver);

    expect(result).toEqual({
      imapHost: "imap.example.com",
      imapPort: 993,
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      security: "tls",
    });
  });

  it("does not throw when the resolver rejects with NXDOMAIN, returns empty", async () => {
    const resolver = makeResolver(async () => {
      const err = new Error("queryStrict ENOTFOUND") as NodeJS.ErrnoException;
      err.code = "ENOTFOUND";
      throw err;
    });

    await expect(discoverViaSrv("example.com", resolver)).resolves.toEqual({});
  });

  it("returns a partial result when only one of the two lookups succeeds", async () => {
    const resolver = makeResolver(async (name: string) => {
      if (name === "_imaps._tcp.example.com") {
        return [{ name: "imap.example.com", port: 993, priority: 10, weight: 0 }];
      }
      throw new Error("NXDOMAIN");
    });

    const result = await discoverViaSrv("example.com", resolver);

    expect(result).toEqual({
      imapHost: "imap.example.com",
      imapPort: 993,
      security: "tls",
    });
  });

  it("picks the record with the lowest priority number (highest priority) when multiple are returned", async () => {
    const resolver = makeResolver(async (name: string) => {
      if (name === "_imaps._tcp.example.com") {
        return [
          { name: "backup-imap.example.com", port: 993, priority: 20, weight: 0 },
          { name: "primary-imap.example.com", port: 993, priority: 5, weight: 0 },
        ];
      }
      return [];
    });

    const result = await discoverViaSrv("example.com", resolver);

    expect(result.imapHost).toBe("primary-imap.example.com");
  });

  it("discovers SMTP from _submissions._tcp (RFC 8314 implicit TLS) when the legacy _submission._tcp is absent", async () => {
    // Real-world case (Migadu-hosted domains, e.g. heypinchy.com): only
    // _submissions._tcp (implicit TLS, 465) is published; the older
    // _submission._tcp (587) does not exist. Querying just the RFC 6186 name
    // left the SMTP host blank.
    const resolver = makeResolver(async (name: string) => {
      if (name === "_imaps._tcp.example.com") {
        return [{ name: "imap.example.com", port: 993, priority: 0, weight: 1 }];
      }
      if (name === "_submissions._tcp.example.com") {
        return [{ name: "smtp.example.com", port: 465, priority: 0, weight: 1 }];
      }
      const err = new Error("ENOTFOUND") as NodeJS.ErrnoException;
      err.code = "ENOTFOUND";
      throw err;
    });

    const result = await discoverViaSrv("example.com", resolver);

    expect(result.smtpHost).toBe("smtp.example.com");
    expect(result.smtpPort).toBe(465);
  });

  it("prefers the implicit-TLS submission record (_submissions._tcp) over the STARTTLS one (_submission._tcp) when both exist", async () => {
    const resolver = makeResolver(async (name: string) => {
      if (name === "_submissions._tcp.example.com") {
        return [{ name: "implicit.example.com", port: 465, priority: 0, weight: 1 }];
      }
      if (name === "_submission._tcp.example.com") {
        return [{ name: "starttls.example.com", port: 587, priority: 0, weight: 1 }];
      }
      return [];
    });

    const result = await discoverViaSrv("example.com", resolver);

    expect(result.smtpHost).toBe("implicit.example.com");
    expect(result.smtpPort).toBe(465);
  });

  it("falls back to the STARTTLS IMAP record (_imap._tcp) when _imaps._tcp is absent", async () => {
    const resolver = makeResolver(async (name: string) => {
      if (name === "_imap._tcp.example.com") {
        return [{ name: "imap.example.com", port: 143, priority: 0, weight: 1 }];
      }
      return [];
    });

    const result = await discoverViaSrv("example.com", resolver);

    expect(result.imapHost).toBe("imap.example.com");
    expect(result.imapPort).toBe(143);
  });

  it("treats an SRV record with a root ('.') target as 'service not offered' (RFC 6186), not a host", async () => {
    const resolver = makeResolver(async (name: string) => {
      if (name === "_imaps._tcp.example.com") {
        return [{ name: "imap.example.com", port: 993, priority: 0, weight: 1 }];
      }
      if (name === "_submissions._tcp.example.com") {
        // "." explicitly signals the service is NOT available at this domain.
        return [{ name: ".", port: 0, priority: 0, weight: 1 }];
      }
      return [];
    });

    const result = await discoverViaSrv("example.com", resolver);

    expect(result.imapHost).toBe("imap.example.com");
    expect(result.smtpHost).toBeUndefined();
    expect(result.smtpPort).toBeUndefined();
  });
});

describe("autodiscover", () => {
  it("short-circuits on a provider-table hit without calling the resolver", async () => {
    const resolveSrv = vi.fn();
    const result = await autodiscover("someone@gmail.com", {
      resolver: { resolveSrv },
    });

    expect(result.source).toBe("provider-table");
    expect(result.config).toEqual({
      imapHost: "imap.gmail.com",
      imapPort: 993,
      smtpHost: "smtp.gmail.com",
      smtpPort: 587,
      security: "tls",
    });
    expect(resolveSrv).not.toHaveBeenCalled();
  });

  it("falls back to DNS-SRV when the provider table misses", async () => {
    const resolveSrv = vi.fn(async (name: string) => {
      if (name === "_imaps._tcp.unknown-domain.example") {
        return [{ name: "mail.unknown-domain.example", port: 993, priority: 0, weight: 0 }];
      }
      return [];
    });

    const result = await autodiscover("user@unknown-domain.example", {
      resolver: { resolveSrv },
    });

    expect(result.source).toBe("dns-srv");
    expect(result.config.imapHost).toBe("mail.unknown-domain.example");
  });

  it("falls back to guessed hosts when both provider table and SRV miss", async () => {
    const resolveSrv = vi.fn(async () => []);

    const result = await autodiscover("user@unknown-domain.example", {
      resolver: { resolveSrv },
    });

    expect(result.source).toBe("guess");
    expect(result.config).toEqual({
      imapHost: "imap.unknown-domain.example",
      imapPort: 993,
      smtpHost: "smtp.unknown-domain.example",
      smtpPort: 587,
      security: "tls",
    });
  });

  it("returns source 'none' for an invalid email", async () => {
    const result = await autodiscover("not-an-email");
    expect(result).toEqual({ config: {}, source: "none" });
  });

  it("never throws even when the resolver throws synchronously/rejects — still returns a guess", async () => {
    const resolveSrv = vi.fn(async () => {
      throw new Error("boom");
    });

    const result = await autodiscover("user@unknown-domain.example", {
      resolver: { resolveSrv },
    });

    expect(result.source).toBe("guess");
    expect(result.config.imapHost).toBe("imap.unknown-domain.example");
  });

  it("uses the default (real) resolver dependency when none is injected, without throwing", async () => {
    // No resolver injected — exercises the default dependency wiring. Uses an
    // unresolvable domain so this stays fast and network-result-agnostic; the
    // only contract under test is "never throws, always resolves".
    await expect(autodiscover("user@unknown-domain.example")).resolves.toBeDefined();
  });

  it("uses MX-provider detection when the provider table misses (the helmcraft.ai/Migadu case)", async () => {
    // Real-world motivating case: helmcraft.ai is hosted at Migadu but has no
    // SRV records, so it used to fall all the way through to the wrong
    // `imap.helmcraft.ai` guess. Its MX records (aspmx1/aspmx2.migadu.com)
    // identify Migadu unambiguously — and MX now runs before SRV.
    const resolveSrv = vi.fn(async () => []);
    const resolveMx = vi.fn(async (name: string) => {
      if (name === "helmcraft.ai") {
        return [
          { exchange: "aspmx2.migadu.com", priority: 20 },
          { exchange: "aspmx1.migadu.com", priority: 10 },
        ];
      }
      return [];
    });

    const result = await autodiscover("someone@helmcraft.ai", {
      resolver: { resolveSrv, resolveMx },
    });

    expect(result.source).toBe("mx-provider");
    expect(result.config).toEqual({
      imapHost: "imap.migadu.com",
      imapPort: 993,
      smtpHost: "smtp.migadu.com",
      smtpPort: 465,
      security: "tls",
    });
  });

  it("prefers an MX-provider match over a DNS-SRV record — SRV is not even consulted (the heypinchy.com misconfigured-port case)", async () => {
    // heypinchy.com is hosted at Migadu and DOES publish an SRV record, but it
    // is misconfigured: `_imaps._tcp` points at imap.migadu.com:995 (Migadu's
    // POP3S port, not IMAPS/993), so trusting SRV yields a mailbox that fails
    // to connect. The MX records identify Migadu, whose VERIFIED IMAP port is
    // 993 — so the MX-provider tier must win over (and short-circuit) SRV.
    const resolveSrv = vi.fn(async (name: string) => {
      if (name === "_imaps._tcp.heypinchy.com") {
        return [{ name: "imap.migadu.com", port: 995, priority: 0, weight: 0 }];
      }
      return [];
    });
    const resolveMx = vi.fn(async () => [{ exchange: "aspmx1.migadu.com", priority: 10 }]);

    const result = await autodiscover("clemens@heypinchy.com", {
      resolver: { resolveSrv, resolveMx },
    });

    expect(result.source).toBe("mx-provider");
    expect(result.config.imapPort).toBe(993); // NOT the SRV's wrong 995
    expect(resolveSrv).not.toHaveBeenCalled();
  });

  it("falls all the way to guess when provider table, SRV, and MX all miss", async () => {
    const resolveSrv = vi.fn(async () => []);
    const resolveMx = vi.fn(async () => []);

    const result = await autodiscover("user@unknown-domain.example", {
      resolver: { resolveSrv, resolveMx },
    });

    expect(result.source).toBe("guess");
    expect(result.config).toEqual({
      imapHost: "imap.unknown-domain.example",
      imapPort: 993,
      smtpHost: "smtp.unknown-domain.example",
      smtpPort: 587,
      security: "tls",
    });
  });

  it("falls to guess without crashing when the resolver has no resolveMx (old resolver shape)", async () => {
    const resolveSrv = vi.fn(async () => []);

    // Deliberately the OLD resolver shape — no resolveMx at all — to prove
    // the MX tier is skipped gracefully for callers/tests that predate it.
    const result = await autodiscover("user@unknown-domain.example", {
      resolver: { resolveSrv },
    });

    expect(result.source).toBe("guess");
  });

  it("falls to guess without crashing when resolveMx rejects", async () => {
    const resolveSrv = vi.fn(async () => []);
    const resolveMx = vi.fn(async () => {
      throw new Error("MX lookup boom");
    });

    const result = await autodiscover("user@unknown-domain.example", {
      resolver: { resolveSrv, resolveMx },
    });

    expect(result.source).toBe("guess");
  });
});
