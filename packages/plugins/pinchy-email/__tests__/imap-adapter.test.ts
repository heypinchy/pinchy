import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ImapAdapter,
  resolveFolders,
  buildImapSearch,
  type ImapAdapterOptions,
} from "../imap-adapter.js";

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
      buildImapSearch({ from: "a@example.com", unread: true, sinceDays: 1 }, now),
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
      resolveFolders([{ path: "INBOX", specialUse: undefined, flags: new Set() }])
        .INBOX,
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
    await expect(adapter.list({ folder: "DRAFTS" })).rejects.toThrow(
      /DRAFTS/,
    );
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
      asyncIterableOf(many.slice(-20).reverse().map((uid) => envelopeMessage({ uid }))),
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
