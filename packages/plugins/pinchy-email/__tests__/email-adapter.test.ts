import { describe, it, expect } from "vitest";
import { createFolderMapper, escapeDoubleQuoted, type Folder } from "../email-adapter.js";

describe("escapeDoubleQuoted", () => {
  it("passes a plain value through unchanged", () => {
    expect(escapeDoubleQuoted("alice@example.com")).toBe("alice@example.com");
  });

  it("escapes backslashes BEFORE quotes so a trailing backslash can't escape the closing quote", () => {
    // If quotes were escaped first, the literal backslash in the input would
    // then double-escape the already-inserted `\"`, producing `\\"` — which
    // reads as an escaped backslash followed by an unescaped quote, breaking
    // out of the wrapper. Backslash-first avoids that.
    expect(escapeDoubleQuoted('a"b\\c')).toBe('a\\"b\\\\c');
  });

  it("escapes a lone trailing backslash so it cannot escape the closing quote", () => {
    expect(escapeDoubleQuoted("foo\\")).toBe("foo\\\\");
  });
});

describe("createFolderMapper", () => {
  const mapFolder = createFolderMapper({
    INBOX: "inbox-value",
    SENT: "sent-value",
    DRAFTS: "drafts-value",
    TRASH: "trash-value",
    SPAM: "spam-value",
  });

  it("maps each canonical folder to its provider-specific value", () => {
    expect(mapFolder("INBOX")).toBe("inbox-value");
    expect(mapFolder("SENT")).toBe("sent-value");
    expect(mapFolder("DRAFTS")).toBe("drafts-value");
    expect(mapFolder("TRASH")).toBe("trash-value");
    expect(mapFolder("SPAM")).toBe("spam-value");
  });

  it("throws a consistent error message for an unmapped folder", () => {
    expect(() => mapFolder("ARCHIVE" as Folder)).toThrow(
      "unknown folder: ARCHIVE. Valid: INBOX, SENT, DRAFTS, TRASH, SPAM."
    );
  });

  it("maps a lowercase folder name to the same value as its canonical form", () => {
    expect(mapFolder("inbox" as Folder)).toBe("inbox-value");
  });

  it("maps a mixed-case folder name to the same value as its canonical form", () => {
    expect(mapFolder("Inbox" as Folder)).toBe("inbox-value");
  });

  it("maps a folder name with surrounding whitespace to the same value as its canonical form", () => {
    expect(mapFolder("  sent  " as Folder)).toBe("sent-value");
  });

  it("still throws for a genuinely unknown folder, quoting the original input", () => {
    expect(() => mapFolder("archive" as Folder)).toThrow(
      "unknown folder: archive. Valid: INBOX, SENT, DRAFTS, TRASH, SPAM."
    );
  });
});
