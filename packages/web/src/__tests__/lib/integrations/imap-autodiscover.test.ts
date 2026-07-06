import { describe, it, expect, vi } from "vitest";
import {
  isSafeAutodiscoverUrl,
  discoverViaSrv,
  autodiscover,
  type SrvResolver,
} from "@/lib/integrations/imap-autodiscover";
import { lookupProviderTable } from "@/lib/integrations/imap-providers";

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
});
