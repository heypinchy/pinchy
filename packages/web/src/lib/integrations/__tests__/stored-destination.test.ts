import { describe, it, expect, vi, afterEach } from "vitest";
import { checkStoredDestination } from "../stored-destination";

// Every host here is an IP literal: `validateExternalUrl` classifies those from
// the string alone, and `dns.lookup` answers a literal with itself, so no test
// in this file depends on a resolver or the network.

describe("checkStoredDestination", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
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
      expect(result).toEqual({ allowed: true });
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

    it("allows a public stored URL", async () => {
      const result = await checkStoredDestination("odoo", odoo("https://93.184.216.34"));
      expect(result).toEqual({ allowed: true });
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
      expect(result).toEqual({ allowed: true });
    });

    it("still refuses a metadata host with ALLOW_PRIVATE_MAIL_HOSTS=1", async () => {
      vi.stubEnv("ALLOW_PRIVATE_MAIL_HOSTS", "1");
      const result = await checkStoredDestination("imap", imap("fd00:ec2::254", "192.168.1.20"));
      expect(result).toMatchObject({ allowed: false, field: "imapHost" });
    });

    // A host saved before the guard refused `%` must not keep being used: it was
    // checked with the part after `%` dropped, the mail client connects to all of it.
    it("refuses a stored host containing `%`, which the guard used to check only in part", async () => {
      const result = await checkStoredDestination(
        "imap",
        imap("93.184.216.34", "a%b.attacker.test")
      );
      expect(result).toEqual({
        allowed: false,
        field: "smtpHost",
        message: expect.stringContaining('"%"'),
      });
    });
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
