// Unit tests for createEmailPort — the sweep's `createPort` dependency in
// production: connectionId -> decrypted credentials -> a provider-specific
// EmailPort.
//
// The provider adapters are covered by their own tests (and end-to-end against
// their mocks); what is proven here is the dispatch itself: the right adapter
// for the connection's type, and a loud failure for a connection that is not a
// mailbox at all.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/integrations/resolve-credentials", () => ({
  resolveConnectionCredentials: vi.fn(),
}));

vi.mock("@/lib/email-workflows/ports/imap", () => ({
  createImapPort: vi.fn().mockReturnValue({ search: vi.fn(), read: vi.fn(), close: vi.fn() }),
}));

vi.mock("@/lib/email-workflows/ports/graph", () => ({
  createGraphPort: vi.fn().mockReturnValue({ search: vi.fn(), read: vi.fn() }),
}));

vi.mock("@/lib/email-workflows/ports/gmail", () => ({
  createGmailPort: vi.fn().mockReturnValue({ search: vi.fn(), read: vi.fn() }),
}));

// The guard's decisions are tested in stored-destination.test.ts; here only
// whether the sweep asks it before connecting, and what it does with a "no".
vi.mock("@/lib/integrations/stored-destination", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/integrations/stored-destination")>();
  return { ...actual, checkStoredDestination: vi.fn() };
});

import { resolveConnectionCredentials } from "@/lib/integrations/resolve-credentials";
import { createImapPort } from "@/lib/email-workflows/ports/imap";
import { createGraphPort } from "@/lib/email-workflows/ports/graph";
import { createGmailPort } from "@/lib/email-workflows/ports/gmail";
import { createEmailPort } from "@/lib/email-workflows/port";
import {
  checkStoredDestination,
  StoredDestinationRefusedError,
} from "@/lib/integrations/stored-destination";

describe("createEmailPort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkStoredDestination).mockResolvedValue({ allowed: true });
  });

  describe("stored mail host is re-checked before the sweep connects", () => {
    // The host was checked when the connection was saved, never again — so a
    // connection saved under older rules (100.x was public) or before the
    // operator removed ALLOW_PRIVATE_MAIL_HOSTS kept being swept.
    const credentials = { imapHost: "100.64.0.9", smtpHost: "100.64.0.9", username: "u" };

    it("asks the guard about the stored credentials", async () => {
      vi.mocked(resolveConnectionCredentials).mockResolvedValue({ type: "imap", credentials });

      await createEmailPort("conn-1");

      expect(checkStoredDestination).toHaveBeenCalledWith("imap", credentials);
    });

    it("throws a configuration error — not an auth error — and never builds the port", async () => {
      vi.mocked(resolveConnectionCredentials).mockResolvedValue({ type: "imap", credentials });
      vi.mocked(checkStoredDestination).mockResolvedValue({
        allowed: false,
        field: "imapHost",
        message:
          "Blocked: this host resolves to a private network address. Set ALLOW_PRIVATE_MAIL_HOSTS=1 to allow an on-premise mail server.",
      });

      const error = await createEmailPort("conn-1").catch((e: unknown) => e);

      expect(error).toBeInstanceOf(StoredDestinationRefusedError);
      expect((error as StoredDestinationRefusedError).field).toBe("imapHost");
      // The sweep logs this line beside the workflow's `error` status; it has
      // to name the fix, and must not read as a credentials problem.
      expect((error as Error).message).toContain("ALLOW_PRIVATE_MAIL_HOSTS=1");
      expect((error as Error).message).not.toMatch(/authenticat|credential/i);
      expect(createImapPort).not.toHaveBeenCalled();
    });
  });

  it("builds an IMAP port from an imap connection's decrypted credentials", async () => {
    const credentials = { imapHost: "mail.example.com", username: "u", password: "p" };
    vi.mocked(resolveConnectionCredentials).mockResolvedValue({ type: "imap", credentials });

    const port = await createEmailPort("conn-1");

    expect(resolveConnectionCredentials).toHaveBeenCalledWith("conn-1");
    expect(createImapPort).toHaveBeenCalledWith(credentials);
    expect(port.search).toBeDefined();
  });

  it("builds a Graph port from a microsoft connection's decrypted credentials", async () => {
    const credentials = {
      accessToken: "tok",
      refreshToken: "r",
      expiresAt: "2026-07-18T00:00:00Z",
    };
    vi.mocked(resolveConnectionCredentials).mockResolvedValue({ type: "microsoft", credentials });

    const port = await createEmailPort("conn-ms");

    expect(createGraphPort).toHaveBeenCalledWith(credentials);
    expect(port.search).toBeDefined();
  });

  it("builds a Gmail port from a google connection's decrypted credentials", async () => {
    const credentials = {
      accessToken: "tok",
      refreshToken: "r",
      expiresAt: "2026-07-18T00:00:00Z",
    };
    vi.mocked(resolveConnectionCredentials).mockResolvedValue({ type: "google", credentials });

    const port = await createEmailPort("conn-gmail");

    expect(createGmailPort).toHaveBeenCalledWith(credentials);
    expect(port.search).toBeDefined();
  });

  it("throws for a connection that is not a mailbox", async () => {
    // A workflow pointed at an Odoo or web-search connection is a configuration
    // bug. Fail loudly at the sweep's unit level (surfacing as the workflow's
    // `error` status) rather than returning a port that no-ops forever.
    vi.mocked(resolveConnectionCredentials).mockResolvedValue({ type: "odoo", credentials: {} });

    await expect(createEmailPort("conn-odoo")).rejects.toThrow(/not a mailbox|odoo/i);
  });
});
