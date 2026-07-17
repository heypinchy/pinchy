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

import { resolveConnectionCredentials } from "@/lib/integrations/resolve-credentials";
import { createImapPort } from "@/lib/email-workflows/ports/imap";
import { createEmailPort } from "@/lib/email-workflows/port";

describe("createEmailPort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds an IMAP port from an imap connection's decrypted credentials", async () => {
    const credentials = { imapHost: "mail.example.com", username: "u", password: "p" };
    vi.mocked(resolveConnectionCredentials).mockResolvedValue({ type: "imap", credentials });

    const port = await createEmailPort("conn-1");

    expect(resolveConnectionCredentials).toHaveBeenCalledWith("conn-1");
    expect(createImapPort).toHaveBeenCalledWith(credentials);
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
