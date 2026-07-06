import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ImapAdapter,
  resolveFolders,
  buildImapSearch,
  type ImapAdapterOptions,
} from "../imap-adapter.js";

// Shared mock SMTP transport for send() tests. Created inside vi.hoisted() so
// it's visible to the vi.mock("nodemailer", ...) factory below, which vitest
// hoists above these imports/consts.
const { mockTransport, createTransportMock } = vi.hoisted(() => {
  const mockTransport = {
    sendMail: vi.fn(),
    close: vi.fn(),
  };
  const createTransportMock = vi.fn().mockReturnValue(mockTransport);
  return { mockTransport, createTransportMock };
});

vi.mock("nodemailer", () => ({
  default: { createTransport: createTransportMock },
  createTransport: createTransportMock,
}));

const opts: ImapAdapterOptions = {
  imapHost: "imap.example.com",
  imapPort: 993,
  smtpHost: "smtp.example.com",
  smtpPort: 587,
  username: "user@example.com",
  password: "app-pw",
  security: "tls",
};

// Shared mock ImapFlow client. Each test configures list/search/fetch return
// values; connect/logout/mailboxOpen are tracked so tests can assert the
// connection lifecycle (always closed) and the mailbox that was opened.
// vi.mock factories are hoisted above imports/consts, so the mock object
// itself must be created inside vi.hoisted() to be visible at mock-eval time.
const { mockClient } = vi.hoisted(() => ({
  mockClient: {
    connect: vi.fn(),
    logout: vi.fn(),
    list: vi.fn(),
    mailboxOpen: vi.fn(),
    search: vi.fn(),
    fetch: vi.fn(),
    fetchOne: vi.fn(),
    append: vi.fn(),
  },
}));

vi.mock("imapflow", () => ({
  ImapFlow: vi.fn().mockImplementation(function ImapFlow() {
    return mockClient;
  }),
}));

function envelopeMessage(overrides: {
  uid: number;
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
  seen?: boolean;
}) {
  return {
    uid: overrides.uid,
    envelope: {
      from: overrides.from ? [{ address: overrides.from }] : [],
      to: overrides.to ? [{ address: overrides.to }] : [],
      subject: overrides.subject ?? "",
      date: overrides.date ?? "2026-01-01T00:00:00.000Z",
    },
    flags: new Set(overrides.seen === false ? [] : ["\\Seen"]),
  };
}

function asyncIterableOf<T>(items: T[]): AsyncIterableIterator<T> {
  let i = 0;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (i < items.length) {
        return { value: items[i++], done: false };
      }
      return { value: undefined, done: true };
    },
  } as AsyncIterableIterator<T>;
}

const SERVER_MAILBOXES = [
  { path: "INBOX", specialUse: undefined, flags: new Set<string>() },
  { path: "Sent Items", specialUse: "\\Sent", flags: new Set(["\\Sent"]) },
];

beforeEach(() => {
  mockClient.connect.mockReset().mockResolvedValue(undefined);
  mockClient.logout.mockReset().mockResolvedValue(undefined);
  mockClient.list.mockReset().mockResolvedValue(SERVER_MAILBOXES);
  mockClient.mailboxOpen.mockReset().mockResolvedValue({});
  mockClient.search.mockReset().mockResolvedValue([]);
  mockClient.fetch.mockReset().mockReturnValue(asyncIterableOf([]));
  mockClient.fetchOne.mockReset().mockResolvedValue(false);
  mockClient.append.mockReset().mockResolvedValue({
    destination: "Drafts",
    uid: 123,
  });
  mockTransport.sendMail.mockReset().mockResolvedValue({
    messageId: "<generated@smtp.example.com>",
  });
  mockTransport.close.mockReset();
  createTransportMock.mockClear();
});

// Builds a real RFC822 multipart/mixed message: a multipart/alternative body
// (text/plain + text/html) plus one inline attachment. Used to exercise
// mailparser's REAL parsing (not mocked) end-to-end through read()/
// getAttachment(). CRLF line endings match real IMAP message sources.
function buildMultipartFixture(): string {
  const attachmentContent = Buffer.from("quarterly numbers here").toString(
    "base64",
  );
  return [
    "From: Alice Sender <alice@example.com>",
    "To: Bob Recipient <bob@example.com>",
    "Cc: Carol Copy <carol@example.com>",
    "Subject: Quarterly report attached",
    "Date: Mon, 6 Jul 2026 12:00:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="BOUNDARY1"',
    "",
    "--BOUNDARY1",
    'Content-Type: multipart/alternative; boundary="BOUNDARY2"',
    "",
    "--BOUNDARY2",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hello Bob, please find the quarterly report attached. Thanks, Alice",
    "",
    "--BOUNDARY2",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>Hello Bob, please find the <b>quarterly report</b> attached.</p>",
    "",
    "--BOUNDARY2--",
    "--BOUNDARY1",
    'Content-Type: text/plain; name="report.txt"',
    'Content-Disposition: attachment; filename="report.txt"',
    "Content-Transfer-Encoding: base64",
    "Content-ID: <report123@example.com>",
    "",
    attachmentContent,
    "",
    "--BOUNDARY1--",
    "",
  ].join("\r\n");
}

// html-only fixture with skipHtmlToText-style content: no text/plain part at
// all, so read() must fall back to stripping the html body itself.
function buildHtmlOnlyFixture(): string {
  return [
    "From: Dave <dave@example.com>",
    "To: Eve <eve@example.com>",
    "Subject: HTML only",
    "Date: Tue, 7 Jul 2026 08:30:00 +0000",
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>Hello <b>Eve</b>, this is <i>only</i> HTML.</p>",
    "",
  ].join("\r\n");
}

describe("ImapAdapter#read", () => {
  it("maps a multipart message to EmailFull, preferring text/plain over html", async () => {
    mockClient.fetchOne.mockResolvedValue({
      source: Buffer.from(buildMultipartFixture()),
      flags: new Set(["\\Seen"]),
    });

    const adapter = new ImapAdapter(opts);
    const result = await adapter.read("42");

    expect(mockClient.mailboxOpen).toHaveBeenCalledWith("INBOX");
    expect(mockClient.fetchOne).toHaveBeenCalledWith(
      42,
      { source: true, flags: true },
      { uid: true },
    );
    expect(result.id).toBe("42");
    expect(result.from).toBe('"Alice Sender" <alice@example.com>');
    expect(result.to).toBe('"Bob Recipient" <bob@example.com>');
    expect(result.cc).toBe('"Carol Copy" <carol@example.com>');
    expect(result.subject).toBe("Quarterly report attached");
    expect(result.date).toBe("2026-07-06T12:00:00.000Z");
    // Prefers text/plain over text/html
    expect(result.body).toContain(
      "Hello Bob, please find the quarterly report attached. Thanks, Alice",
    );
    expect(result.body).not.toContain("<b>");
    expect(result.unread).toBe(false);
  });

  it("derives a whitespace-collapsed snippet from the body", async () => {
    mockClient.fetchOne.mockResolvedValue({
      source: Buffer.from(buildMultipartFixture()),
      flags: new Set(["\\Seen"]),
    });

    const adapter = new ImapAdapter(opts);
    const result = await adapter.read("42");

    expect(result.snippet).toBe(
      "Hello Bob, please find the quarterly report attached. Thanks, Alice",
    );
    expect(result.snippet).not.toMatch(/\n/);
  });

  it("marks unread true when \\Seen flag is absent", async () => {
    mockClient.fetchOne.mockResolvedValue({
      source: Buffer.from(buildMultipartFixture()),
      flags: new Set<string>(),
    });

    const adapter = new ImapAdapter(opts);
    const result = await adapter.read("42");

    expect(result.unread).toBe(true);
  });

  it("falls back to the stripped html body when there is no text/plain part", async () => {
    mockClient.fetchOne.mockResolvedValue({
      source: Buffer.from(buildHtmlOnlyFixture()),
      flags: new Set(["\\Seen"]),
    });

    const adapter = new ImapAdapter(opts);
    const result = await adapter.read("7");

    expect(result.body).toContain("Hello");
    expect(result.body).toContain("Eve");
    expect(result.body).not.toContain("<b>");
    expect(result.body).not.toContain("<p>");
  });

  it("lists attachment metadata with filename, mimeType, size, and id", async () => {
    mockClient.fetchOne.mockResolvedValue({
      source: Buffer.from(buildMultipartFixture()),
      flags: new Set(["\\Seen"]),
    });

    const adapter = new ImapAdapter(opts);
    const result = await adapter.read("42");

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({
      filename: "report.txt",
      mimeType: "text/plain",
      size: 22,
    });
    expect(result.attachments[0].id).toBeTruthy();
  });

  it("throws a clear error when the message uid is not found", async () => {
    mockClient.fetchOne.mockResolvedValue(false);

    const adapter = new ImapAdapter(opts);
    await expect(adapter.read("999")).rejects.toThrow("message 999 not found");
    // Connection must still be closed even though the fetch missed.
    expect(mockClient.connect).toHaveBeenCalledTimes(1);
    expect(mockClient.logout).toHaveBeenCalledTimes(1);
  });
});

describe("ImapAdapter#getAttachment", () => {
  it("returns filename, mimeType, and Buffer data for a matching attachment id", async () => {
    mockClient.fetchOne.mockResolvedValue({
      source: Buffer.from(buildMultipartFixture()),
      flags: new Set(["\\Seen"]),
    });

    const adapter = new ImapAdapter(opts);
    const read = await adapter.read("42");
    const attachmentId = read.attachments[0].id;

    const attachment = await adapter.getAttachment("42", attachmentId);

    expect(attachment.filename).toBe("report.txt");
    expect(attachment.mimeType).toBe("text/plain");
    expect(attachment.data).toBeInstanceOf(Buffer);
    expect(attachment.data.toString()).toBe("quarterly numbers here");
  });

  it("opens INBOX and fetches the message by uid", async () => {
    mockClient.fetchOne.mockResolvedValue({
      source: Buffer.from(buildMultipartFixture()),
      flags: new Set(["\\Seen"]),
    });

    const adapter = new ImapAdapter(opts);
    await adapter.getAttachment("42", "<report123@example.com>");

    expect(mockClient.mailboxOpen).toHaveBeenCalledWith("INBOX");
    expect(mockClient.fetchOne).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ source: true }),
      { uid: true },
    );
  });

  it("throws a clear error for an unknown attachment id", async () => {
    mockClient.fetchOne.mockResolvedValue({
      source: Buffer.from(buildMultipartFixture()),
      flags: new Set(["\\Seen"]),
    });

    const adapter = new ImapAdapter(opts);
    await expect(adapter.getAttachment("42", "does-not-exist")).rejects.toThrow(
      "attachment does-not-exist not found",
    );
  });

  it("throws a clear error when the message uid is not found", async () => {
    mockClient.fetchOne.mockResolvedValue(false);

    const adapter = new ImapAdapter(opts);
    await expect(adapter.getAttachment("999", "whatever")).rejects.toThrow(
      "message 999 not found",
    );
  });
});

describe("ImapAdapter", () => {
  it("constructs with connection options", () => {
    const a = new ImapAdapter(opts);
    expect(a).toBeInstanceOf(ImapAdapter);
  });
});

describe("buildImapSearch", () => {
  const now = new Date("2026-07-06T12:00:00.000Z");

  it("returns {} for empty opts", () => {
    expect(buildImapSearch({}, now)).toEqual({});
  });

  it("ignores folder/limit — they are not IMAP SEARCH keys", () => {
    expect(buildImapSearch({ folder: "SENT", limit: 5 }, now)).toEqual({});
  });

  it("maps unread: true to { seen: false }", () => {
    expect(buildImapSearch({ unread: true }, now)).toEqual({ seen: false });
  });

  it("maps unread: false to { seen: true }", () => {
    expect(buildImapSearch({ unread: false }, now)).toEqual({ seen: true });
  });

  it("maps from/to/subject directly", () => {
    expect(
      buildImapSearch(
        { from: "a@example.com", to: "b@example.com", subject: "hello" },
        now,
      ),
    ).toEqual({ from: "a@example.com", to: "b@example.com", subject: "hello" });
  });

  it("maps text to a body search", () => {
    expect(buildImapSearch({ text: "invoice 123" }, now)).toEqual({
      body: "invoice 123",
    });
  });

  it("maps sinceDays to a deterministic since Date relative to the given now", () => {
    const result = buildImapSearch({ sinceDays: 7 }, now);
    expect(result.since).toBeInstanceOf(Date);
    expect((result.since as Date).toISOString()).toBe(
      "2026-06-29T12:00:00.000Z",
    );
  });

  it("combines multiple fields", () => {
    expect(
      buildImapSearch(
        { from: "a@example.com", unread: true, sinceDays: 1 },
        now,
      ),
    ).toEqual({
      from: "a@example.com",
      seen: false,
      since: new Date("2026-07-05T12:00:00.000Z"),
    });
  });
});

describe("resolveFolders", () => {
  it("maps folders from SPECIAL-USE flags (RFC 6154)", () => {
    const boxes = [
      { path: "INBOX", specialUse: undefined, flags: new Set<string>() },
      { path: "Sent Items", specialUse: "\\Sent", flags: new Set(["\\Sent"]) },
      {
        path: "MyDrafts",
        specialUse: "\\Drafts",
        flags: new Set(["\\Drafts"]),
      },
      { path: "Bin", specialUse: "\\Trash", flags: new Set(["\\Trash"]) },
      { path: "Junk", specialUse: "\\Junk", flags: new Set(["\\Junk"]) },
    ];
    expect(resolveFolders(boxes)).toEqual({
      INBOX: "INBOX",
      SENT: "Sent Items",
      DRAFTS: "MyDrafts",
      TRASH: "Bin",
      SPAM: "Junk",
    });
  });

  it("falls back to name heuristics when SPECIAL-USE is absent", () => {
    const boxes = [
      { path: "INBOX", specialUse: undefined, flags: new Set<string>() },
      { path: "Sent", specialUse: undefined, flags: new Set<string>() },
      { path: "Drafts", specialUse: undefined, flags: new Set<string>() },
      { path: "Trash", specialUse: undefined, flags: new Set<string>() },
      { path: "Spam", specialUse: undefined, flags: new Set<string>() },
    ];
    const r = resolveFolders(boxes);
    expect(r.SENT).toBe("Sent");
    expect(r.SPAM).toBe("Spam");
  });

  it("always resolves INBOX even with no other folders", () => {
    expect(
      resolveFolders([
        { path: "INBOX", specialUse: undefined, flags: new Set() },
      ]).INBOX,
    ).toBe("INBOX");
  });

  it("matches full name-heuristic set case-insensitively", () => {
    const boxes = [
      { path: "inbox", specialUse: undefined, flags: new Set<string>() },
      { path: "sent", specialUse: undefined, flags: new Set<string>() },
      { path: "DRAFTS", specialUse: undefined, flags: new Set<string>() },
      { path: "Trash", specialUse: undefined, flags: new Set<string>() },
      { path: "SPAM", specialUse: undefined, flags: new Set<string>() },
    ];
    expect(resolveFolders(boxes)).toEqual({
      INBOX: "INBOX",
      SENT: "sent",
      DRAFTS: "DRAFTS",
      TRASH: "Trash",
      SPAM: "SPAM",
    });
  });

  it("maps localized/varied server folder names via heuristics", () => {
    const boxes = [
      { path: "INBOX", specialUse: undefined, flags: new Set<string>() },
      { path: "Gesendet", specialUse: undefined, flags: new Set<string>() },
      { path: "Entwürfe", specialUse: undefined, flags: new Set<string>() },
      {
        path: "Deleted Items",
        specialUse: undefined,
        flags: new Set<string>(),
      },
      {
        path: "Junk E-mail",
        specialUse: undefined,
        flags: new Set<string>(),
      },
    ];
    expect(resolveFolders(boxes)).toEqual({
      INBOX: "INBOX",
      SENT: "Gesendet",
      DRAFTS: "Entwürfe",
      TRASH: "Deleted Items",
      SPAM: "Junk E-mail",
    });
  });

  it("prefers SPECIAL-USE over a conflicting path name", () => {
    // Path looks like "Trash" heuristically, but SPECIAL-USE says it's really Sent.
    const boxes = [
      { path: "INBOX", specialUse: undefined, flags: new Set<string>() },
      { path: "Trash", specialUse: "\\Sent", flags: new Set(["\\Sent"]) },
    ];
    expect(resolveFolders(boxes).SENT).toBe("Trash");
  });

  it("leaves a folder unset when neither SPECIAL-USE nor heuristic matches", () => {
    const boxes = [
      { path: "INBOX", specialUse: undefined, flags: new Set<string>() },
      { path: "Archive", specialUse: undefined, flags: new Set<string>() },
    ];
    const r = resolveFolders(boxes);
    expect(r.INBOX).toBe("INBOX");
    expect(r.SENT).toBeUndefined();
    expect(r.DRAFTS).toBeUndefined();
    expect(r.TRASH).toBeUndefined();
    expect(r.SPAM).toBeUndefined();
  });

  it("resolves plural 'Sent Mail' and 'Deleted Messages' variants", () => {
    const boxes = [
      { path: "INBOX", specialUse: undefined, flags: new Set<string>() },
      { path: "Sent Mail", specialUse: undefined, flags: new Set<string>() },
      {
        path: "Deleted Messages",
        specialUse: undefined,
        flags: new Set<string>(),
      },
    ];
    const r = resolveFolders(boxes);
    expect(r.SENT).toBe("Sent Mail");
    expect(r.TRASH).toBe("Deleted Messages");
  });
});

describe("ImapAdapter#list", () => {
  it("opens INBOX by default and lists all messages", async () => {
    mockClient.search.mockResolvedValue([2, 1]);
    mockClient.fetch.mockReturnValue(
      asyncIterableOf([
        envelopeMessage({ uid: 1, from: "a@example.com", subject: "hi" }),
        envelopeMessage({ uid: 2, from: "b@example.com", subject: "yo" }),
      ]),
    );

    const adapter = new ImapAdapter(opts);
    const result = await adapter.list({});

    expect(mockClient.mailboxOpen).toHaveBeenCalledWith("INBOX");
    expect(mockClient.search).toHaveBeenCalledWith(
      { all: true },
      { uid: true },
    );
    expect(result).toHaveLength(2);
    // newest UID first
    expect(result[0].id).toBe("2");
    expect(result[1].id).toBe("1");
    expect(mockClient.connect).toHaveBeenCalledTimes(1);
    expect(mockClient.logout).toHaveBeenCalledTimes(1);
  });

  it("maps unreadOnly to a { seen: false } search", async () => {
    const adapter = new ImapAdapter(opts);
    await adapter.list({ unreadOnly: true });

    expect(mockClient.search).toHaveBeenCalledWith(
      { seen: false },
      { uid: true },
    );
  });

  it("maps EmailSummary fields including unread from flags", async () => {
    mockClient.search.mockResolvedValue([1, 2]);
    mockClient.fetch.mockReturnValue(
      asyncIterableOf([
        envelopeMessage({
          uid: 1,
          from: "a@example.com",
          to: "me@example.com",
          subject: "Read message",
          seen: true,
        }),
        envelopeMessage({
          uid: 2,
          from: "b@example.com",
          to: "me@example.com",
          subject: "Unread message",
          seen: false,
        }),
      ]),
    );

    const adapter = new ImapAdapter(opts);
    const result = await adapter.list({});

    const read = result.find((m) => m.id === "1")!;
    const unread = result.find((m) => m.id === "2")!;
    expect(read.unread).toBe(false);
    expect(unread.unread).toBe(true);
    expect(read.from).toBe("a@example.com");
    expect(read.to).toBe("me@example.com");
    expect(read.subject).toBe("Read message");
  });

  it("resolves a non-INBOX folder to its real server path", async () => {
    const adapter = new ImapAdapter(opts);
    await adapter.list({ folder: "SENT" });

    expect(mockClient.mailboxOpen).toHaveBeenCalledWith("Sent Items");
  });

  it("throws when the requested folder does not resolve on the server", async () => {
    const adapter = new ImapAdapter(opts);
    await expect(adapter.list({ folder: "DRAFTS" })).rejects.toThrow(/DRAFTS/);
    // Connection must still be closed even though resolution failed.
    expect(mockClient.connect).toHaveBeenCalledTimes(1);
    expect(mockClient.logout).toHaveBeenCalledTimes(1);
  });

  it("applies limit, capping at N newest results", async () => {
    mockClient.search.mockResolvedValue([1, 2, 3, 4, 5]);
    mockClient.fetch.mockReturnValue(
      asyncIterableOf([
        envelopeMessage({ uid: 5 }),
        envelopeMessage({ uid: 4 }),
        envelopeMessage({ uid: 3 }),
      ]),
    );

    const adapter = new ImapAdapter(opts);
    const result = await adapter.list({ limit: 3 });

    expect(result).toHaveLength(3);
    expect(result.map((m) => m.id)).toEqual(["5", "4", "3"]);
  });

  it("defaults to a limit of 20 when omitted", async () => {
    const many = Array.from({ length: 30 }, (_, i) => i + 1);
    mockClient.search.mockResolvedValue(many);
    mockClient.fetch.mockReturnValue(
      asyncIterableOf(
        many
          .slice(-20)
          .reverse()
          .map((uid) => envelopeMessage({ uid })),
      ),
    );

    const adapter = new ImapAdapter(opts);
    const result = await adapter.list({});

    expect(result).toHaveLength(20);
  });

  it("returns an empty array without calling fetch when search finds nothing", async () => {
    mockClient.search.mockResolvedValue([]);
    const adapter = new ImapAdapter(opts);
    const result = await adapter.list({});
    expect(result).toEqual([]);
    expect(mockClient.fetch).not.toHaveBeenCalled();
  });
});

describe("ImapAdapter#search", () => {
  it("builds search criteria from structured DSL and passes it to client.search", async () => {
    const adapter = new ImapAdapter(opts);
    await adapter.search({ from: "boss@example.com", unread: true });

    expect(mockClient.search).toHaveBeenCalledWith(
      { from: "boss@example.com", seen: false },
      { uid: true },
    );
  });

  it("defaults to INBOX when folder is omitted", async () => {
    const adapter = new ImapAdapter(opts);
    await adapter.search({ subject: "invoice" });

    expect(mockClient.mailboxOpen).toHaveBeenCalledWith("INBOX");
  });

  it("resolves folder SENT to the real mailbox path 'Sent Items'", async () => {
    const adapter = new ImapAdapter(opts);
    await adapter.search({ folder: "SENT", subject: "invoice" });

    expect(mockClient.mailboxOpen).toHaveBeenCalledWith("Sent Items");
  });

  it("maps results to EmailSummary with correct unread flag", async () => {
    mockClient.search.mockResolvedValue([9]);
    mockClient.fetch.mockReturnValue(
      asyncIterableOf([
        envelopeMessage({
          uid: 9,
          from: "x@example.com",
          subject: "Match",
          seen: false,
        }),
      ]),
    );

    const adapter = new ImapAdapter(opts);
    const result = await adapter.search({ text: "match" });

    expect(result).toEqual([
      {
        id: "9",
        from: "x@example.com",
        to: "",
        subject: "Match",
        date: "2026-01-01T00:00:00.000Z",
        snippet: "",
        unread: true,
      },
    ]);
  });

  it("caps results at limit", async () => {
    mockClient.search.mockResolvedValue([1, 2, 3]);
    mockClient.fetch.mockReturnValue(
      asyncIterableOf([
        envelopeMessage({ uid: 3 }),
        envelopeMessage({ uid: 2 }),
      ]),
    );

    const adapter = new ImapAdapter(opts);
    const result = await adapter.search({ text: "x", limit: 2 });

    expect(result).toHaveLength(2);
  });

  it("throws a clear error when the requested folder is not found on the server", async () => {
    const adapter = new ImapAdapter(opts);
    await expect(
      adapter.search({ folder: "TRASH", subject: "x" }),
    ).rejects.toThrow("folder TRASH not found on server");
  });

  it("always closes the connection, even when search criteria match nothing", async () => {
    mockClient.search.mockResolvedValue([]);
    const adapter = new ImapAdapter(opts);
    await adapter.search({ subject: "nothing" });

    expect(mockClient.connect).toHaveBeenCalledTimes(1);
    expect(mockClient.logout).toHaveBeenCalledTimes(1);
  });

  it("passes an empty-opts search (match-all) as {} to client.search", async () => {
    const adapter = new ImapAdapter(opts);
    await adapter.search({});

    expect(mockClient.search).toHaveBeenCalledWith({}, { uid: true });
  });
});

// Server mailbox list that includes a DRAFTS folder, for draft() tests.
const SERVER_MAILBOXES_WITH_DRAFTS = [
  { path: "INBOX", specialUse: undefined, flags: new Set<string>() },
  { path: "Sent Items", specialUse: "\\Sent", flags: new Set(["\\Sent"]) },
  { path: "Drafts", specialUse: "\\Drafts", flags: new Set(["\\Drafts"]) },
];

describe("ImapAdapter#draft", () => {
  it("appends a raw RFC822 message to the resolved DRAFTS path with the \\Draft flag", async () => {
    mockClient.list.mockResolvedValue(SERVER_MAILBOXES_WITH_DRAFTS);

    const adapter = new ImapAdapter(opts);
    const result = await adapter.draft({
      to: "bob@example.com",
      subject: "Quarterly report",
      body: "Please find it attached.",
    });

    expect(mockClient.append).toHaveBeenCalledTimes(1);
    const [path, raw, flags] = mockClient.append.mock.calls[0];
    expect(path).toBe("Drafts");
    expect(flags).toEqual(["\\Draft"]);
    const rawStr = Buffer.isBuffer(raw) ? raw.toString("utf-8") : String(raw);
    expect(rawStr).toContain("Quarterly report");
    expect(rawStr).toContain("Please find it attached.");
    expect(rawStr).toContain("bob@example.com");
    expect(result.draftId).toBe("123");
    expect(mockClient.connect).toHaveBeenCalledTimes(1);
    expect(mockClient.logout).toHaveBeenCalledTimes(1);
  });

  it("includes In-Reply-To when replyTo is provided", async () => {
    mockClient.list.mockResolvedValue(SERVER_MAILBOXES_WITH_DRAFTS);

    const adapter = new ImapAdapter(opts);
    await adapter.draft({
      to: "bob@example.com",
      subject: "Re: Quarterly report",
      body: "Thanks!",
      replyTo: "<original-msg-id@example.com>",
    });

    const raw = mockClient.append.mock.calls[0][1];
    const rawStr = Buffer.isBuffer(raw) ? raw.toString("utf-8") : String(raw);
    expect(rawStr).toContain("In-Reply-To: <original-msg-id@example.com>");
  });

  it("returns a stable non-empty draftId even when append returns no uid", async () => {
    mockClient.list.mockResolvedValue(SERVER_MAILBOXES_WITH_DRAFTS);
    mockClient.append.mockResolvedValue({ destination: "Drafts" });

    const adapter = new ImapAdapter(opts);
    const result = await adapter.draft({
      to: "bob@example.com",
      subject: "No uid",
      body: "body",
    });

    expect(result.draftId).toBeTruthy();
    expect(typeof result.draftId).toBe("string");
  });

  it("throws when the server has no resolvable DRAFTS folder", async () => {
    mockClient.list.mockResolvedValue(SERVER_MAILBOXES); // no Drafts folder

    const adapter = new ImapAdapter(opts);
    await expect(
      adapter.draft({
        to: "bob@example.com",
        subject: "hi",
        body: "hi",
      }),
    ).rejects.toThrow("folder DRAFTS not found on server");
    expect(mockClient.append).not.toHaveBeenCalled();
    expect(mockClient.connect).toHaveBeenCalledTimes(1);
    expect(mockClient.logout).toHaveBeenCalledTimes(1);
  });

  it("throws on CR/LF header injection in `to` and does not call append", async () => {
    mockClient.list.mockResolvedValue(SERVER_MAILBOXES_WITH_DRAFTS);
    const adapter = new ImapAdapter(opts);

    await expect(
      adapter.draft({
        to: "victim@example.com\r\nBcc: attacker@evil.com",
        subject: "hi",
        body: "hi",
      }),
    ).rejects.toThrow();
    expect(mockClient.append).not.toHaveBeenCalled();
  });

  it("throws on CR/LF header injection in `subject` and does not call append", async () => {
    mockClient.list.mockResolvedValue(SERVER_MAILBOXES_WITH_DRAFTS);
    const adapter = new ImapAdapter(opts);

    await expect(
      adapter.draft({
        to: "bob@example.com",
        subject: "Innocent\r\nBcc: attacker@evil.com",
        body: "hi",
      }),
    ).rejects.toThrow();
    expect(mockClient.append).not.toHaveBeenCalled();
  });
});

describe("ImapAdapter#send", () => {
  it("creates a transport with secure: true for security 'tls' and calls sendMail", async () => {
    const adapter = new ImapAdapter(opts);
    const result = await adapter.send({
      to: "bob@example.com",
      subject: "Hello",
      body: "World",
    });

    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: opts.smtpHost,
        port: opts.smtpPort,
        secure: true,
        requireTLS: false,
        auth: { user: opts.username, pass: opts.password },
      }),
    );
    expect(mockTransport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: opts.username,
        to: "bob@example.com",
        subject: "Hello",
        text: "World",
      }),
    );
    expect(result.messageId).toBe("<generated@smtp.example.com>");
    expect(mockTransport.close).toHaveBeenCalledTimes(1);
  });

  it("creates a transport with requireTLS: true for security 'starttls'", async () => {
    const starttlsOpts: ImapAdapterOptions = { ...opts, security: "starttls" };
    const adapter = new ImapAdapter(starttlsOpts);
    await adapter.send({ to: "bob@example.com", subject: "Hi", body: "Hi" });

    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({ secure: false, requireTLS: true }),
    );
  });

  it("creates a transport with neither secure nor requireTLS for security 'none'", async () => {
    const noneOpts: ImapAdapterOptions = { ...opts, security: "none" };
    const adapter = new ImapAdapter(noneOpts);
    await adapter.send({ to: "bob@example.com", subject: "Hi", body: "Hi" });

    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({ secure: false, requireTLS: false }),
    );
  });

  it("passes inReplyTo through when replyTo is provided", async () => {
    const adapter = new ImapAdapter(opts);
    await adapter.send({
      to: "bob@example.com",
      subject: "Re: Hello",
      body: "Thanks",
      replyTo: "<original-msg-id@example.com>",
    });

    expect(mockTransport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        inReplyTo: "<original-msg-id@example.com>",
      }),
    );
  });

  it("returns { messageId: null } when the transport reports no messageId", async () => {
    mockTransport.sendMail.mockResolvedValue({});
    const adapter = new ImapAdapter(opts);
    const result = await adapter.send({
      to: "bob@example.com",
      subject: "Hi",
      body: "Hi",
    });

    expect(result.messageId).toBeNull();
  });

  it("closes the transport even when sendMail throws", async () => {
    mockTransport.sendMail.mockRejectedValue(new Error("smtp down"));
    const adapter = new ImapAdapter(opts);

    await expect(
      adapter.send({ to: "bob@example.com", subject: "Hi", body: "Hi" }),
    ).rejects.toThrow("smtp down");
    expect(mockTransport.close).toHaveBeenCalledTimes(1);
  });

  it("throws on CR/LF header injection in `to` and does not create a transport", async () => {
    const adapter = new ImapAdapter(opts);

    await expect(
      adapter.send({
        to: "victim@example.com\r\nBcc: attacker@evil.com",
        subject: "hi",
        body: "hi",
      }),
    ).rejects.toThrow();
    expect(createTransportMock).not.toHaveBeenCalled();
    expect(mockTransport.sendMail).not.toHaveBeenCalled();
  });

  it("throws on CR/LF header injection in `subject` and does not create a transport", async () => {
    const adapter = new ImapAdapter(opts);

    await expect(
      adapter.send({
        to: "bob@example.com",
        subject: "Innocent\r\nBcc: attacker@evil.com",
        body: "hi",
      }),
    ).rejects.toThrow();
    expect(createTransportMock).not.toHaveBeenCalled();
    expect(mockTransport.sendMail).not.toHaveBeenCalled();
  });
});
