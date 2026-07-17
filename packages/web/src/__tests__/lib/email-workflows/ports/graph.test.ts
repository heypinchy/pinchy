// Unit tests for the Microsoft Graph mailbox port.
//
// Two things are proven here. First the pure mapping (Graph's message shape ->
// the lister's EmailReadResult). Second — and more important — that every
// request carries `Prefer: IdType="ImmutableId"`, which is a *correctness*
// requirement for the ledger, not a nicety. See the drift guard below.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { mapGraphMessage, createGraphPort } from "@/lib/email-workflows/ports/graph";

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

describe("Graph port — mapGraphMessage", () => {
  it("maps a Graph message into an EmailReadResult", () => {
    const mapped = mapGraphMessage({
      folder: "inbox",
      message: {
        id: "AAMkAG-immutable-id",
        subject: "Invoice 4711",
        receivedDateTime: "2026-07-14T09:00:00Z",
        internetMessageId: "<msg-4711@example.com>",
        from: { emailAddress: { name: "Clemens Helm", address: "clemens@example.com" } },
        toRecipients: [
          { emailAddress: { address: "billing@acme.test" } },
          { emailAddress: { address: "ops@acme.test" } },
        ],
        ccRecipients: [{ emailAddress: { address: "archive@acme.test" } }],
        attachments: [
          {
            id: "att-1",
            name: "invoice.pdf",
            contentType: "application/pdf",
            isInline: false,
          },
        ],
      },
    });

    expect(mapped).toEqual({
      id: "AAMkAG-immutable-id",
      // Bare addresses, matching the IMAP port: the lister discards display
      // names anyway and re-emitting them would need comma-quoting.
      from: "clemens@example.com",
      to: "billing@acme.test, ops@acme.test",
      cc: "archive@acme.test",
      subject: "Invoice 4711",
      date: "2026-07-14T09:00:00Z",
      folder: "inbox",
      messageIdHeader: "<msg-4711@example.com>",
      attachments: [{ mimeType: "application/pdf", filename: "invoice.pdf" }],
    });
  });

  it("excludes inline attachments", () => {
    // Graph reports an HTML mail's embedded logo as an attachment with
    // isInline: true. Counting it would fire every hasAttachment filter on
    // ordinary newsletters — the same trap as IMAP's disposition:inline.
    const mapped = mapGraphMessage({
      folder: "inbox",
      message: {
        id: "m1",
        receivedDateTime: "2026-07-14T09:00:00Z",
        attachments: [
          { id: "a1", name: "logo.png", contentType: "image/png", isInline: true },
          { id: "a2", name: "real.pdf", contentType: "application/pdf", isInline: false },
        ],
      },
    });

    expect(mapped.attachments).toEqual([{ mimeType: "application/pdf", filename: "real.pdf" }]);
  });

  it("yields blank fields rather than undefined for a sparse message", () => {
    const mapped = mapGraphMessage({
      folder: "archive",
      message: { id: "m2", receivedDateTime: "2026-07-14T09:00:00Z" },
    });

    expect(mapped.from).toBe("");
    expect(mapped.to).toBe("");
    expect(mapped.cc).toBe("");
    expect(mapped.subject).toBe("");
    expect(mapped.attachments).toEqual([]);
    expect(mapped.messageIdHeader).toBeUndefined();
  });
});

describe("Graph port — immutable ids", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function headersOf(callIndex: number): Headers {
    const init = fetchSpy.mock.calls[callIndex][1] as RequestInit;
    return new Headers(init.headers);
  }

  it("asks Graph for immutable ids when listing", async () => {
    // LOAD-BEARING. The ledger's claim key is (workflow, connection,
    // providerMessageId). Graph's DEFAULT message ids change when a message
    // moves between folders — so without this header, a user filing a processed
    // mail into another folder makes it reappear under a new id, outside the
    // ledger, and it gets processed a second time (a duplicate Odoo entry).
    //
    // The header must also stay CONSISTENT forever: ids minted in immutable mode
    // are not interchangeable with default-mode ids. Removing this header later
    // would invalidate every id already in the ledger at once — the sweep would
    // see an entire window of "new" mail and re-dispatch all of it. That is why
    // this is a guard, not a preference.
    fetchSpy.mockResolvedValue(jsonResponse({ value: [{ id: "m1" }] }));
    const port = createGraphPort(credentials);

    await port.search({ sinceDays: 14, folder: "inbox", limit: 50 });

    expect(headersOf(0).get("Prefer")).toBe('IdType="ImmutableId"');
  });

  it("asks Graph for immutable ids when reading", async () => {
    // The read must agree with the list: an id minted in immutable mode is only
    // valid in immutable mode.
    fetchSpy.mockResolvedValue(
      jsonResponse({ id: "m1", receivedDateTime: "2026-07-14T09:00:00Z" })
    );
    const port = createGraphPort(credentials);

    await port.read("m1");

    expect(headersOf(0).get("Prefer")).toBe('IdType="ImmutableId"');
  });
});

describe("Graph port — search query", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValue(jsonResponse({ value: [] }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function urlOf(callIndex: number): string {
    return decodeURIComponent(String(fetchSpy.mock.calls[callIndex][0]));
  }

  it("scopes the listing to the folder, the window and the limit", async () => {
    const port = createGraphPort(credentials);

    await port.search({ sinceDays: 14, folder: "inbox", limit: 50 });

    const url = urlOf(0);
    expect(url).toContain("/mailFolders/inbox/messages");
    expect(url).toContain("$top=50");
    // Graph requires the first $orderby property to lead the $filter — the
    // plugin's graph-adapter hit this too. Ordering by receivedDateTime desc
    // (newest first, so a bounded page keeps the most recent mail) means the
    // receivedDateTime predicate must come first in the filter.
    expect(url).toContain("$orderby=receivedDateTime desc");
    expect(url).toMatch(/\$filter=receivedDateTime ge /);
  });

  it("surfaces a Graph error instead of reporting an empty mailbox", async () => {
    // A 401/403 answered as "no mail" would read as "nothing new" and silently
    // retire the workflow while its status stayed active.
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Access token expired" } }), { status: 401 })
    );
    const port = createGraphPort(credentials);

    await expect(port.search({ sinceDays: 14 })).rejects.toThrow(/401|Access token expired/i);
  });
});
