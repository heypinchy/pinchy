import { describe, it, expect } from "vitest";
import {
  ImapAdapter,
  resolveFolders,
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

describe("ImapAdapter", () => {
  it("constructs with connection options", () => {
    const a = new ImapAdapter(opts);
    expect(a).toBeInstanceOf(ImapAdapter);
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
