// Unit tests for the IMAP mailbox port's pure mapping layer: imapflow's parsed
// ENVELOPE + BODYSTRUCTURE -> the lister's `EmailReadResult`.
//
// The mapping is the bug-prone half (address shapes, missing headers, nested
// multipart attachment trees) and is pure, so it is unit-tested here against
// real imapflow type shapes. The protocol half (connect / SEARCH / FETCH) is
// exercised end-to-end against GreenMail, where a mock would only prove itself.
//
// The one exception is the connection bookkeeping at the bottom of this file:
// what the port does when a connect FAILS is our logic, not imapflow's, and
// GreenMail cannot exercise it — a healthy server never refuses a connection on
// demand. That describe stubs imapflow for exactly that reason, and asserts on
// the port's own state, never on the stub's protocol behaviour.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockConnect, mockLogout, mockSearch, mockMailboxOpen } = vi.hoisted(() => ({
  mockConnect: vi.fn(),
  mockLogout: vi.fn(),
  mockSearch: vi.fn(),
  mockMailboxOpen: vi.fn(),
}));

vi.mock("imapflow", () => ({
  ImapFlow: class {
    connect = mockConnect;
    logout = mockLogout;
    search = mockSearch;
    mailboxOpen = mockMailboxOpen;
    fetchOne = vi.fn();
  },
}));

import {
  mapImapMessage,
  collectAttachments,
  createImapPort,
} from "@/lib/email-workflows/ports/imap";

describe("IMAP port — mapImapMessage", () => {
  it("maps a full envelope into an EmailReadResult", () => {
    const mapped = mapImapMessage({
      uid: 42,
      folder: "INBOX",
      envelope: {
        date: new Date("2026-07-14T09:00:00.000Z"),
        subject: "Invoice 4711",
        messageId: "<msg-4711@example.com>",
        from: [{ name: "Clemens Helm", address: "clemens@example.com" }],
        to: [{ name: "Billing", address: "billing@acme.test" }, { address: "ops@acme.test" }],
        cc: [{ name: "Archive", address: "archive@acme.test" }],
      },
      bodyStructure: undefined,
    });

    expect(mapped).toEqual({
      id: "42",
      from: "clemens@example.com",
      // Display names are deliberately dropped: the lister discards them anyway
      // (it normalizes to bare addresses), and emitting them would mean quoting
      // names that contain a comma to survive the lister's address split.
      to: "billing@acme.test, ops@acme.test",
      cc: "archive@acme.test",
      subject: "Invoice 4711",
      date: "2026-07-14T09:00:00.000Z",
      folder: "INBOX",
      messageIdHeader: "<msg-4711@example.com>",
      attachments: [],
    });
  });

  it("falls back to the server's internalDate when the message has no Date header", () => {
    // A message without a Date header still has an IMAP INTERNALDATE. Without
    // this fallback the lister would reject it as an unparseable date and its
    // poison-message isolation would silently drop a perfectly real email.
    const mapped = mapImapMessage({
      uid: 7,
      folder: "INBOX",
      envelope: { subject: "no date header", from: [{ address: "a@x.test" }] },
      internalDate: new Date("2026-07-15T10:30:00.000Z"),
    });

    expect(mapped.date).toBe("2026-07-15T10:30:00.000Z");
  });

  it("yields blank fields rather than undefined for a bare envelope", () => {
    // The lister's normalize handles blank To/Cc (it drops empty tokens); what it
    // cannot handle is `undefined` reaching `.split()`.
    const mapped = mapImapMessage({ uid: 1, folder: "Archive", envelope: {} });

    expect(mapped.from).toBe("");
    expect(mapped.to).toBe("");
    expect(mapped.cc).toBe("");
    expect(mapped.subject).toBe("");
    expect(mapped.folder).toBe("Archive");
    expect(mapped.messageIdHeader).toBeUndefined();
  });
});

describe("IMAP port — collectAttachments", () => {
  it("collects attachments from a nested multipart tree", () => {
    const attachments = collectAttachments({
      type: "multipart/mixed",
      childNodes: [
        {
          type: "multipart/alternative",
          childNodes: [{ type: "text/plain" }, { type: "text/html" }],
        },
        {
          type: "application/pdf",
          disposition: "attachment",
          dispositionParameters: { filename: "invoice.pdf" },
        },
      ],
    });

    expect(attachments).toEqual([{ mimeType: "application/pdf", filename: "invoice.pdf" }]);
  });

  it("does not treat an inline body part as an attachment", () => {
    // The filter's hasAttachment gate would otherwise fire on every HTML mail
    // with an inline image, dispatching runs nobody asked for.
    const attachments = collectAttachments({
      type: "multipart/related",
      childNodes: [
        { type: "text/html" },
        {
          type: "image/png",
          disposition: "inline",
          dispositionParameters: { filename: "logo.png" },
        },
      ],
    });

    expect(attachments).toEqual([]);
  });

  it("falls back to the Content-Type name when Content-Disposition carries no filename", () => {
    const attachments = collectAttachments({
      type: "application/pdf",
      disposition: "attachment",
      parameters: { name: "fallback.pdf" },
    });

    expect(attachments).toEqual([{ mimeType: "application/pdf", filename: "fallback.pdf" }]);
  });
});

describe("IMAP port — connection bookkeeping", () => {
  const credentials = {
    imapHost: "mail.example.com",
    imapPort: 993,
    smtpHost: "mail.example.com",
    smtpPort: 587,
    username: "u",
    password: "p",
    security: "tls" as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockMailboxOpen.mockResolvedValue(undefined);
    mockSearch.mockResolvedValue([]);
    mockLogout.mockResolvedValue(undefined);
  });

  it("keeps no half-open client after a failed connect", async () => {
    // The sweep closes every port in a `finally`, including the one whose
    // mailbox was unreachable. If the failed connect left the client cached, that
    // close would call logout() on a socket that never opened — the sweep catches
    // and logs it, so the cost is a misleading "failed to close the port" line on
    // top of the real, already-reported connect failure. Worse, a retry on the
    // same port would skip connect() entirely and act as if it were connected.
    mockConnect.mockRejectedValue(new Error("ECONNREFUSED"));
    const port = createImapPort(credentials);

    await expect(port.search({ sinceDays: 14 })).rejects.toThrow(/ECONNREFUSED/);

    await expect(port.close?.()).resolves.toBeUndefined();
    expect(mockLogout).not.toHaveBeenCalled();
  });

  it("connects once and serves search + read over the same connection", async () => {
    // The lister does 1×search + N×read per unit; a connection per message is not
    // an option (this is why the port holds one at all).
    const port = createImapPort(credentials);

    await port.search({ sinceDays: 14 });
    await port.search({ sinceDays: 14 });

    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it("asks for every message when no window is given, never for `since: undefined`", async () => {
    // The sweep always passes sweepWindowDays, so this is defensive — but an
    // undefined-valued `since` key is the kind of thing a search compiler is free
    // to read as a malformed term rather than an absent one. Say "all" explicitly.
    const port = createImapPort(credentials);

    await port.search({});

    expect(mockSearch).toHaveBeenCalledWith({ all: true }, { uid: true });
  });
});
