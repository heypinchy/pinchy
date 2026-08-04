import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createFolderMapper,
  escapeDoubleQuoted,
  stripHtml,
  truncateEmailBody,
  EMAIL_BODY_MAX_CHARS,
  resolveInsecureMockBaseUrl,
  resetInsecureMockWarningsForTest,
  type Folder,
} from "../email-adapter.js";

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

// stripHtml is a rare fallback for IMAP (mailparser derives text from html
// first) but the PRIMARY path for Graph and for Gmail's html-only messages.
// These assert the properties that matter when a model, not a renderer, is
// the reader.
describe("stripHtml", () => {
  it("removes tags and their attributes", () => {
    expect(stripHtml('<p class="x">Hello <b>Bob</b></p>')).toBe("Hello Bob");
  });

  it("drops script and style bodies rather than reading them as text", () => {
    const html = "<style>.a{color:red}</style><script>alert(1)</script><p>Real text</p>";
    const out = stripHtml(html);
    expect(out).toBe("Real text");
  });

  // Collapsing every block boundary to a space turns a whole email into one
  // endless line — which is what the model then has to reason over.
  it("keeps paragraph and list structure as line breaks", () => {
    const html = "<p>First para</p><p>Second para</p><ul><li>one</li><li>two</li></ul>";
    const out = stripHtml(html);
    expect(out.split("\n").filter(Boolean)).toEqual(["First para", "Second para", "one", "two"]);
  });

  it("collapses runs of blank lines instead of emitting a wall of them", () => {
    expect(stripHtml("<div><div><div><p>Only text</p></div></div></div>")).toBe("Only text");
  });

  it("decodes the entities that actually appear in mail bodies", () => {
    expect(stripHtml("<p>Tom &amp; Jerry &quot;quoted&quot; 3 &lt; 4&nbsp;always</p>")).toBe(
      'Tom & Jerry "quoted" 3 < 4 always'
    );
  });

  // Decoding after tag removal, not before: otherwise an escaped tag in the
  // source becomes a real tag that nothing then strips.
  it("does not let an escaped tag in the source survive as markup", () => {
    expect(stripHtml("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>")).toBe(
      "<script>alert(1)</script>"
    );
  });

  // Outlook conditional comments wrap a whole alternative rendering. Left in,
  // their contents survive tag-stripping and the model reads the mail twice.
  it("drops Outlook conditional-comment markup instead of reading it as content", () => {
    const html =
      "<p>Real</p><!--[if mso]><table><tr><td>MSO fallback</td></tr></table><![endif]-->";
    expect(stripHtml(html)).not.toContain("MSO fallback");
  });

  it("leaves an unknown entity alone rather than silently eating it", () => {
    expect(stripHtml("<p>caf&eacute;</p>")).toBe("caf&eacute;");
  });
});

describe("truncateEmailBody", () => {
  it("returns a body that fits unchanged, with no marker", () => {
    const body = "Line one\n\nLine two.";
    expect(truncateEmailBody(body)).toBe(body);
  });

  it("returns a body of exactly the budget unchanged (the boundary is inclusive)", () => {
    const body = "z".repeat(EMAIL_BODY_MAX_CHARS);
    expect(truncateEmailBody(body)).toBe(body);
  });

  // The marker has to be self-describing: a bare "[truncated]" reads as part
  // of the message, and a model that cannot tell how much it is missing will
  // answer as though it read the whole mail.
  it("keeps the leading budget and states how much of the message it is", () => {
    const body = "z".repeat(EMAIL_BODY_MAX_CHARS * 2);
    const out = truncateEmailBody(body);

    expect(out.startsWith("z".repeat(EMAIL_BODY_MAX_CHARS))).toBe(true);
    expect(out).toContain(String(EMAIL_BODY_MAX_CHARS));
    expect(out).toContain(String(body.length));
    // Bounded overhead: the marker must not itself become a size problem.
    expect(out.length).toBeLessThan(EMAIL_BODY_MAX_CHARS + 500);
  });

  it("honours an explicit budget", () => {
    expect(truncateEmailBody("abcdefghij", 4).startsWith("abcd")).toBe(true);
  });
});

describe("resolveInsecureMockBaseUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetInsecureMockWarningsForTest();
    vi.restoreAllMocks();
  });

  it("returns undefined when the override var is not set", () => {
    expect(resolveInsecureMockBaseUrl("GMAIL_API_BASE_URL", "PINCHY_INSECURE_MAIL_MOCK")).toBe(
      undefined
    );
  });

  it("ignores the override and returns undefined when the insecure flag is absent", () => {
    vi.stubEnv("GMAIL_API_BASE_URL", "http://gmail-mock:9004");
    // No PINCHY_INSECURE_MAIL_MOCK: a stray override left over in production
    // must not silently redirect API calls (and the bearer token sent with
    // them) to whatever host it names.
    expect(resolveInsecureMockBaseUrl("GMAIL_API_BASE_URL", "PINCHY_INSECURE_MAIL_MOCK")).toBe(
      undefined
    );
  });

  it("returns the override when the insecure flag is also set", () => {
    vi.stubEnv("GMAIL_API_BASE_URL", "http://gmail-mock:9004");
    vi.stubEnv("PINCHY_INSECURE_MAIL_MOCK", "1");
    expect(resolveInsecureMockBaseUrl("GMAIL_API_BASE_URL", "PINCHY_INSECURE_MAIL_MOCK")).toBe(
      "http://gmail-mock:9004"
    );
  });

  it('ignores the override when the insecure flag is set to something other than exactly "1"', () => {
    vi.stubEnv("GMAIL_API_BASE_URL", "http://gmail-mock:9004");
    vi.stubEnv("PINCHY_INSECURE_MAIL_MOCK", "true");
    expect(resolveInsecureMockBaseUrl("GMAIL_API_BASE_URL", "PINCHY_INSECURE_MAIL_MOCK")).toBe(
      undefined
    );
  });

  it("warns only once for a repeated read of the same override var", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("GMAIL_API_BASE_URL", "http://gmail-mock:9004");

    resolveInsecureMockBaseUrl("GMAIL_API_BASE_URL", "PINCHY_INSECURE_MAIL_MOCK");
    resolveInsecureMockBaseUrl("GMAIL_API_BASE_URL", "PINCHY_INSECURE_MAIL_MOCK");
    resolveInsecureMockBaseUrl("GMAIL_API_BASE_URL", "PINCHY_INSECURE_MAIL_MOCK");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("GMAIL_API_BASE_URL");
    expect(warn.mock.calls[0][0]).toContain("PINCHY_INSECURE_MAIL_MOCK");
  });

  it("warns separately for each distinct override var", () => {
    // The dedupe is keyed by override var — that is the whole point of the Set.
    // Repeating ONE var proves the "once" half and says nothing about the "per
    // var" half: a plain boolean would pass that test while reporting the Gmail
    // override and then staying silent about the Graph one for the rest of the
    // process.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("GMAIL_API_BASE_URL", "http://gmail-mock:9004");
    vi.stubEnv("GRAPH_API_BASE_URL", "http://graph-mock:9005");

    resolveInsecureMockBaseUrl("GMAIL_API_BASE_URL", "PINCHY_INSECURE_MAIL_MOCK");
    resolveInsecureMockBaseUrl("GRAPH_API_BASE_URL", "PINCHY_INSECURE_MAIL_MOCK");
    resolveInsecureMockBaseUrl("GMAIL_API_BASE_URL", "PINCHY_INSECURE_MAIL_MOCK");
    resolveInsecureMockBaseUrl("GRAPH_API_BASE_URL", "PINCHY_INSECURE_MAIL_MOCK");

    expect(warn).toHaveBeenCalledTimes(2);
    const messages = warn.mock.calls.map((c) => c[0]).join("\n");
    expect(messages).toContain("GMAIL_API_BASE_URL");
    expect(messages).toContain("GRAPH_API_BASE_URL");
  });

  it("treats an empty override as unset, and does not warn about it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("GMAIL_API_BASE_URL", "");
    expect(resolveInsecureMockBaseUrl("GMAIL_API_BASE_URL", "PINCHY_INSECURE_MAIL_MOCK")).toBe(
      undefined
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn when the override is not set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveInsecureMockBaseUrl("GMAIL_API_BASE_URL", "PINCHY_INSECURE_MAIL_MOCK");
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn when the override is set together with the flag", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("GMAIL_API_BASE_URL", "http://gmail-mock:9004");
    vi.stubEnv("PINCHY_INSECURE_MAIL_MOCK", "1");
    resolveInsecureMockBaseUrl("GMAIL_API_BASE_URL", "PINCHY_INSECURE_MAIL_MOCK");
    expect(warn).not.toHaveBeenCalled();
  });
});
