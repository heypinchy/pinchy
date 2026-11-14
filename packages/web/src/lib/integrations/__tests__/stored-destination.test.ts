import { describe, it, expect, vi, afterEach } from "vitest";
import { lookup } from "node:dns/promises";
import { checkStoredDestination } from "../stored-destination";

// Hosts here are IP literals, which the guards classify from the string alone.
// The tests that need a name resolve it through this mock, never the network:
// a lookup no test arranged fails the test instead of reaching a resolver.
function unexpectedLookup(host: string): never {
  throw new Error(`unexpected DNS lookup for "${host}" — arrange it with resolveNames()`);
}

vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return { ...actual, lookup: vi.fn(async (host: string) => unexpectedLookup(host)) };
});

const mockedLookup = vi.mocked(lookup) as unknown as {
  mockImplementation(fn: (host: string) => Promise<unknown>): void;
  mockReset(): void;
};

/** A resolver error as `dns.lookup` raises it. */
function dnsError(code: string, host: string): Error {
  return Object.assign(new Error(`getaddrinfo ${code} ${host}`), { code, hostname: host });
}

/** Answers `answers` per host name; any other name fails with `failures[host]`. */
function resolveNames(
  answers: Record<string, { address: string; family: 4 | 6 }[]>,
  failures: Record<string, Error> = {}
) {
  mockedLookup.mockImplementation(async (host: string) => {
    if (host in failures) throw failures[host];
    if (host in answers) return answers[host];
    throw dnsError("ENOTFOUND", host);
  });
}

describe("checkStoredDestination", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mockedLookup.mockImplementation(async (host: string) => unexpectedLookup(host));
  });

  describe("odoo", () => {
    const odoo = (url: string) => ({ url, db: "prod", login: "admin", apiKey: "k", uid: 2 });

    it("refuses a stored private URL, naming the field and the opt-in", async () => {
      const result = await checkStoredDestination("odoo", odoo("http://10.0.0.5:8069"));
      expect(result).toEqual({
        allowed: false,
        field: "url",
        message: expect.stringContaining("ALLOW_PRIVATE_URLS=1"),
      });
    });

    it("allows the same stored private URL once ALLOW_PRIVATE_URLS=1 is set", async () => {
      vi.stubEnv("ALLOW_PRIVATE_URLS", "1");
      const result = await checkStoredDestination("odoo", odoo("http://100.64.0.7:8069"));
      expect(result).toMatchObject({ allowed: true });
    });

    it.each([
      "http://127.0.0.1:8069",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.100.100.200/",
      "http://[fd20:ce::254]/computeMetadata/v1/",
    ])("refuses the stored URL %s even with ALLOW_PRIVATE_URLS=1", async (url) => {
      vi.stubEnv("ALLOW_PRIVATE_URLS", "1");
      const result = await checkStoredDestination("odoo", odoo(url));
      expect(result).toMatchObject({ allowed: false, field: "url" });
    });

    it("allows a public stored URL and hands back the addresses it checked", async () => {
      const result = await checkStoredDestination("odoo", odoo("https://93.184.216.34"));
      expect(result).toEqual({
        allowed: true,
        pin: { origin: "https://93.184.216.34", target: [{ address: "93.184.216.34", family: 4 }] },
        checked: { url: [{ address: "93.184.216.34", family: 4 }] },
      });
    });
  });

  describe("imap", () => {
    const imap = (imapHost: string, smtpHost: string) => ({
      imapHost,
      imapPort: 993,
      smtpHost,
      smtpPort: 587,
      username: "u",
      password: "p",
      security: "tls",
    });

    it("refuses a stored private IMAP host, naming the field and the opt-in", async () => {
      const result = await checkStoredDestination("imap", imap("10.0.0.5", "93.184.216.34"));
      expect(result).toEqual({
        allowed: false,
        field: "imapHost",
        message: expect.stringContaining("ALLOW_PRIVATE_MAIL_HOSTS=1"),
      });
    });

    it("checks the SMTP host too — the agent's send tool connects there", async () => {
      const result = await checkStoredDestination("imap", imap("93.184.216.34", "127.0.0.1"));
      expect(result).toMatchObject({ allowed: false, field: "smtpHost" });
    });

    it("allows private hosts once ALLOW_PRIVATE_MAIL_HOSTS=1 is set", async () => {
      vi.stubEnv("ALLOW_PRIVATE_MAIL_HOSTS", "1");
      const result = await checkStoredDestination("imap", imap("100.64.0.9", "192.168.1.20"));
      expect(result).toEqual({
        allowed: true,
        checked: {
          imapHost: [{ address: "100.64.0.9", family: 4 }],
          smtpHost: [{ address: "192.168.1.20", family: 4 }],
        },
      });
    });

    it("hands back the addresses it checked for each host, for the plugin to pin to", async () => {
      const result = await checkStoredDestination(
        "imap",
        imap("93.184.216.34", "2606:4700:4700::1111")
      );
      expect(result).toEqual({
        allowed: true,
        checked: {
          imapHost: [{ address: "93.184.216.34", family: 4 }],
          smtpHost: [{ address: "2606:4700:4700::1111", family: 6 }],
        },
      });
    });

    // Not a refusal: no address means no connection, and the commonest cause
    // is a typo the plugin's own error names. The E2E mail mock relies on it
    // too — it stores names that never resolve and redirects the connection.
    // The plugin refuses to connect to a host without checked addresses.
    it.each(["ENOTFOUND", "ENODATA", "EAI_FAIL"])(
      "allows a host with no answer (%s), with no checked addresses and a no-answer note",
      async (code) => {
        resolveNames(
          { "imap.example.com": [{ address: "93.184.216.34", family: 4 }] },
          { "smtp.example.com": dnsError(code, "smtp.example.com") }
        );
        const result = await checkStoredDestination(
          "imap",
          imap("imap.example.com", "smtp.example.com")
        );
        expect(result).toEqual({
          allowed: true,
          checked: { imapHost: [{ address: "93.184.216.34", family: 4 }] },
          lookupFailures: { smtpHost: "no-answer" },
        });
      }
    );

    // A lookup that failed says nothing about the name. It must not read as
    // "the host does not resolve", and it must not refuse the connection
    // either — the next fetch may well succeed.
    it.each(["EAI_AGAIN", "ETIMEOUT", "ESERVFAIL", "ECONNREFUSED"])(
      "marks a host whose lookup failed (%s) as temporary, not as missing",
      async (code) => {
        resolveNames(
          { "imap.example.com": [{ address: "93.184.216.34", family: 4 }] },
          { "smtp.example.com": dnsError(code, "smtp.example.com") }
        );
        const result = await checkStoredDestination(
          "imap",
          imap("imap.example.com", "smtp.example.com")
        );
        expect(result).toEqual({
          allowed: true,
          checked: { imapHost: [{ address: "93.184.216.34", family: 4 }] },
          lookupFailures: { smtpHost: "temporary" },
        });
      }
    );

    it("reports both hosts when both lookups failed", async () => {
      resolveNames(
        {},
        {
          "imap.example.com": dnsError("EAI_AGAIN", "imap.example.com"),
          "smtp.example.com": dnsError("ENOTFOUND", "smtp.example.com"),
        }
      );
      const result = await checkStoredDestination(
        "imap",
        imap("imap.example.com", "smtp.example.com")
      );
      expect(result).toEqual({
        allowed: true,
        checked: {},
        lookupFailures: { imapHost: "temporary", smtpHost: "no-answer" },
      });
    });

    it("rethrows an error that is not a DNS failure", async () => {
      mockedLookup.mockImplementation(async () => {
        throw new TypeError("resolver exploded");
      });
      await expect(
        checkStoredDestination("imap", imap("imap.example.com", "93.184.216.34"))
      ).rejects.toThrow("resolver exploded");
    });

    it("pins a resolved name to every address it answered with", async () => {
      resolveNames({
        "imap.example.com": [
          { address: "93.184.216.34", family: 4 },
          { address: "2606:4700:4700::1111", family: 6 },
        ],
      });
      const result = await checkStoredDestination(
        "imap",
        imap("imap.example.com", "93.184.216.35")
      );
      expect(result).toEqual({
        allowed: true,
        checked: {
          imapHost: [
            { address: "93.184.216.34", family: 4 },
            { address: "2606:4700:4700::1111", family: 6 },
          ],
          smtpHost: [{ address: "93.184.216.35", family: 4 }],
        },
      });
    });

    it("still refuses a metadata host with ALLOW_PRIVATE_MAIL_HOSTS=1", async () => {
      vi.stubEnv("ALLOW_PRIVATE_MAIL_HOSTS", "1");
      const result = await checkStoredDestination("imap", imap("fd00:ec2::254", "192.168.1.20"));
      expect(result).toMatchObject({ allowed: false, field: "imapHost" });
    });

    // A host saved before the guard refused malformed hosts must not keep being
    // used: it was checked in a normalised form (trimmed, brackets and anything
    // after `%` dropped), while the mail client connects to the stored string.
    it.each(["a%b.attacker.test", "[a.attacker.test", "a.attacker.test]", " a.attacker.test"])(
      "refuses a stored host the guard used to check only in part (%j)",
      async (host) => {
        const result = await checkStoredDestination("imap", imap("93.184.216.34", host));
        expect(result).toEqual({
          allowed: false,
          field: "smtpHost",
          message: expect.stringContaining("plain host name or IP address"),
        });
      }
    );
  });

  // The Odoo side never had the mail guard's split: the check and odoo-node's
  // fetch read the host through the same WHATWG parser, which refuses `%` in a
  // host outright (percent-decoded or not) and an IPv6 zone ID with it. Pinned,
  // so a future normalizer added in front of the parser cannot open the gap.
  it.each(["http://a%25b.example.com", "http://a%b.example.com", "http://[fe80::1%25eth0]:8069"])(
    "refuses a stored Odoo URL with `%%` in its host (%s)",
    async (url) => {
      const result = await checkStoredDestination("odoo", {
        url,
        db: "prod",
        login: "admin",
        apiKey: "k",
        uid: 2,
      });
      expect(result).toMatchObject({ allowed: false, field: "url" });
    }
  );

  it.each(["microsoft", "google", "web-search"])(
    "has nothing to check for %s — its host is fixed, not stored",
    async (type) => {
      const result = await checkStoredDestination(type, { accessToken: "t", apiKey: "k" });
      expect(result).toEqual({ allowed: true });
    }
  );
});
