// Unit tests for the IMAP mailbox port's pure mapping layer: imapflow's parsed
// ENVELOPE + BODYSTRUCTURE -> the lister's `EmailReadResult`.
//
// The mapping is the bug-prone half (address shapes, missing headers, nested
// multipart attachment trees) and is pure, so it is unit-tested here against
// real imapflow type shapes. The protocol half (connect / SEARCH / FETCH) is
// exercised end-to-end against GreenMail, where a mock would only prove itself.
import { describe, it, expect } from "vitest";

import { mapImapMessage, collectAttachments } from "@/lib/email-workflows/ports/imap";

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
