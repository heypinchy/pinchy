import { describe, it, expect } from "vitest";
import {
  canonicalDestinationUrl,
  auditableDestinationUrl,
  baseUrlDestinationChange,
  integrationDestinationChange,
} from "@/lib/secret-destination";

describe("canonicalDestinationUrl", () => {
  it("lowercases the host, drops the default port and ignores a trailing slash", () => {
    expect(canonicalDestinationUrl("HTTPS://Acme.Example.com:443/v1/")).toBe(
      "https://acme.example.com/v1"
    );
    expect(canonicalDestinationUrl("https://acme.example.com/v1")).toBe(
      "https://acme.example.com/v1"
    );
  });

  it("keeps the path, a non-default port and the query — each can route to someone else", () => {
    expect(canonicalDestinationUrl("https://gw.example.com:8443/v1/acct-a/gw?x=1")).toBe(
      "https://gw.example.com:8443/v1/acct-a/gw?x=1"
    );
  });

  it("returns null for a URL that does not parse", () => {
    expect(canonicalDestinationUrl("not a url")).toBeNull();
  });
});

describe("auditableDestinationUrl", () => {
  it("drops userinfo and the query, which can carry credentials", () => {
    expect(auditableDestinationUrl("https://user:pw@odoo.example.com/odoo/?token=abc")).toBe(
      "https://odoo.example.com/odoo"
    );
  });

  it("names an unparseable URL instead of echoing it", () => {
    expect(auditableDestinationUrl("::nope::")).toBe("(unparseable URL)");
  });
});

describe("baseUrlDestinationChange", () => {
  it("is null when only a trailing slash or letter case differs", () => {
    expect(
      baseUrlDestinationChange("https://acme.example.com/v1", "https://ACME.example.com/v1/")
    ).toBeNull();
  });

  it("reports a path-only change: a shared gateway origin routes by path", () => {
    expect(
      baseUrlDestinationChange(
        "https://gateway.ai.cloudflare.com/v1/acct-a/gw",
        "https://gateway.ai.cloudflare.com/v1/acct-b/gw"
      )
    ).toEqual({
      from: "https://gateway.ai.cloudflare.com/v1/acct-a/gw",
      to: "https://gateway.ai.cloudflare.com/v1/acct-b/gw",
    });
  });

  it("treats an unreadable stored URL as changed", () => {
    expect(baseUrlDestinationChange("::bad::", "https://acme.example.com/v1")).not.toBeNull();
  });
});

describe("integrationDestinationChange", () => {
  const odoo = { url: "https://odoo.example.com", db: "prod", login: "admin" };

  it("odoo: is null when url/db are absent or equal (trailing slash ignored)", () => {
    expect(integrationDestinationChange("odoo", odoo, { login: "bob" })).toBeNull();
    expect(
      integrationDestinationChange("odoo", odoo, { url: "https://odoo.example.com/", db: "prod" })
    ).toBeNull();
  });

  it("odoo: a new url or database is a new destination for the API key", () => {
    expect(integrationDestinationChange("odoo", odoo, { url: "https://attacker.example" })).toEqual(
      {
        secretField: "apiKey",
        changes: { url: { from: "https://odoo.example.com", to: "https://attacker.example" } },
      }
    );
    expect(integrationDestinationChange("odoo", odoo, { db: "other" })).toEqual({
      secretField: "apiKey",
      changes: { db: { from: "prod", to: "other" } },
    });
  });

  const imap = {
    imapHost: "imap.example.com",
    imapPort: 993,
    smtpHost: "smtp.example.com",
    smtpPort: 587,
    username: "team@example.com",
    security: "tls",
  };

  it("imap: prefilled form values (string ports, host case) are not a change", () => {
    expect(
      integrationDestinationChange("imap", imap, {
        imapHost: "IMAP.example.com",
        imapPort: "993",
        smtpHost: "smtp.example.com",
        smtpPort: "587",
        username: "other@example.com",
        security: "tls",
      })
    ).toBeNull();
  });

  it.each([
    ["imapHost", "imap.attacker.example"],
    ["smtpHost", "smtp.attacker.example"],
    ["imapPort", 143],
    ["smtpPort", 25],
    ["security", "none"],
  ])("imap: a changed %s needs the password again", (field, value) => {
    const change = integrationDestinationChange("imap", imap, { [field]: value });
    expect(change?.secretField).toBe("password");
    expect(change?.changes).toHaveProperty(field);
  });

  it("has no destination rule for types whose destination is fixed", () => {
    expect(integrationDestinationChange("web-search", {}, { apiKey: "x" })).toBeNull();
  });
});
