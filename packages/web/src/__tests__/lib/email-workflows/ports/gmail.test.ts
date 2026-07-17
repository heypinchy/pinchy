// Unit tests for the Gmail mailbox port.
//
// Two halves: the pure mapping (Gmail's header-array + MIME-part-tree shape ->
// the lister's EmailReadResult), and the listing query — where Gmail has a trap
// the pinchy-email plugin already paid for (see the labelIds guard below).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { mapGmailMessage, createGmailPort } from "@/lib/email-workflows/ports/gmail";

const credentials = {
  accessToken: "test-access-token",
  refreshToken: "test-refresh-token",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Gmail port — mapGmailMessage", () => {
  it("maps headers into an EmailReadResult", () => {
    const mapped = mapGmailMessage({
      folder: "INBOX",
      message: {
        id: "18c0ff33",
        internalDate: "1752483600000",
        payload: {
          mimeType: "multipart/mixed",
          headers: [
            { name: "From", value: "Clemens Helm <clemens@example.com>" },
            { name: "To", value: "billing@acme.test, ops@acme.test" },
            { name: "Cc", value: "archive@acme.test" },
            { name: "Subject", value: "Invoice 4711" },
            { name: "Date", value: "Tue, 14 Jul 2026 09:00:00 +0000" },
            { name: "Message-ID", value: "<msg-4711@example.com>" },
          ],
        },
      },
    });

    expect(mapped.id).toBe("18c0ff33");
    // Raw header values are passed through: the lister is what normalizes
    // `Display Name <addr>` and splits the recipient list, and it already
    // handles quoted names containing commas.
    expect(mapped.from).toBe("Clemens Helm <clemens@example.com>");
    expect(mapped.to).toBe("billing@acme.test, ops@acme.test");
    expect(mapped.cc).toBe("archive@acme.test");
    expect(mapped.subject).toBe("Invoice 4711");
    expect(mapped.date).toBe("Tue, 14 Jul 2026 09:00:00 +0000");
    expect(mapped.folder).toBe("INBOX");
    expect(mapped.messageIdHeader).toBe("<msg-4711@example.com>");
    expect(mapped.attachments).toEqual([]);
  });

  it("reads headers case-insensitively", () => {
    // RFC 5322 header names are case-insensitive and Gmail echoes whatever the
    // sender wrote, so a `MESSAGE-ID`/`from` spelling must not silently drop the
    // field (a missing Message-ID is invisible; a missing Date is a dropped mail).
    const mapped = mapGmailMessage({
      folder: "INBOX",
      message: {
        id: "m1",
        internalDate: "1752483600000",
        payload: {
          headers: [
            { name: "from", value: "a@x.test" },
            { name: "SUBJECT", value: "shouty" },
            { name: "message-id", value: "<lower@x.test>" },
          ],
        },
      },
    });

    expect(mapped.from).toBe("a@x.test");
    expect(mapped.subject).toBe("shouty");
    expect(mapped.messageIdHeader).toBe("<lower@x.test>");
  });

  it("falls back to internalDate when the message has no Date header", () => {
    // Same trap as IMAP: without the fallback the lister rejects it as an
    // unparseable date and its poison-message isolation drops a real email.
    const mapped = mapGmailMessage({
      folder: "INBOX",
      message: {
        id: "m2",
        internalDate: "1752576600000", // ms since epoch, as a string
        payload: { headers: [{ name: "From", value: "a@x.test" }] },
      },
    });

    expect(mapped.date).toBe(new Date(1752576600000).toISOString());
  });

  it("collects real attachments from the part tree but skips inline parts", () => {
    const mapped = mapGmailMessage({
      folder: "INBOX",
      message: {
        id: "m3",
        internalDate: "1752483600000",
        payload: {
          mimeType: "multipart/mixed",
          headers: [],
          parts: [
            { mimeType: "text/plain", filename: "", headers: [] },
            {
              mimeType: "multipart/related",
              filename: "",
              headers: [],
              parts: [
                {
                  mimeType: "image/png",
                  filename: "logo.png",
                  headers: [{ name: "Content-Disposition", value: 'inline; filename="logo.png"' }],
                  body: { attachmentId: "a1" },
                },
              ],
            },
            {
              mimeType: "application/pdf",
              filename: "invoice.pdf",
              headers: [
                { name: "Content-Disposition", value: 'attachment; filename="invoice.pdf"' },
              ],
              body: { attachmentId: "a2" },
            },
          ],
        },
      },
    });

    // The inline logo is the HTML body's own image — counting it would fire
    // every workflow's hasAttachment filter on ordinary newsletters.
    expect(mapped.attachments).toEqual([{ mimeType: "application/pdf", filename: "invoice.pdf" }]);
  });
});

describe("Gmail port — listing query", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValue(jsonResponse({ messages: [] }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function urlOf(callIndex: number): string {
    return decodeURIComponent(String(fetchSpy.mock.calls[callIndex][0]));
  }

  it("scopes the folder with the labelIds API param, never with the q query", async () => {
    // LOAD-BEARING, and learned the hard way in the pinchy-email plugin: Gmail's
    // `q` language only documents `in:trash`/`in:spam` for folder scoping.
    // `label:INBOX` works only via undocumented aliasing in the q parser, and
    // Gmail search excludes Trash/Spam by default — so scoping a folder through
    // `q` risks SILENTLY EMPTY results. For a sweep, silently-empty is the worst
    // possible failure: it reads as "nothing new" and the workflow looks healthy
    // while quietly processing no mail at all. labelIds is the documented param.
    const port = createGmailPort(credentials);

    await port.search({ sinceDays: 14, folder: "INBOX", limit: 50 });

    const url = urlOf(0);
    expect(url).toContain("labelIds=INBOX");
    expect(url).not.toMatch(/q=[^&]*(in:|label:)/);
  });

  it("bounds the window with newer_than and the volume with maxResults", async () => {
    const port = createGmailPort(credentials);

    await port.search({ sinceDays: 14, folder: "INBOX", limit: 50 });

    const url = urlOf(0);
    expect(url).toContain("newer_than:14d");
    expect(url).toContain("maxResults=50");
  });

  it("surfaces a Gmail error instead of reporting an empty mailbox", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Invalid Credentials" } }), { status: 401 })
    );
    const port = createGmailPort(credentials);

    await expect(port.search({ sinceDays: 14 })).rejects.toThrow(/401|Invalid Credentials/i);
  });

  it("returns an empty list for a mailbox with no matching mail", async () => {
    // Gmail omits `messages` entirely (rather than sending []) when nothing
    // matches — a .map on undefined would crash the whole sweep unit.
    fetchSpy.mockResolvedValue(jsonResponse({ resultSizeEstimate: 0 }));
    const port = createGmailPort(credentials);

    await expect(port.search({ sinceDays: 14 })).resolves.toEqual([]);
  });
});
