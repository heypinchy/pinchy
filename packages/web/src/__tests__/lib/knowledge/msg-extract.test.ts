/**
 * `parseMsg` + `formatEmailText`: an Outlook `.msg` as searchable text (#1409).
 *
 * A mail saved out of Outlook onto a share is often the only record of an
 * agreement — the offer, the order confirmation, the complaint. What a reader
 * searches for is in the headers as much as in the body: who sent it, to whom,
 * when, about what, and which file came with it. The fixtures are built here
 * (`test-helpers/msg-fixture.ts`), so every byte they carry is visible.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  EMAIL_CONTEXT_LINE_MAX_CHARS,
  emailContextLine,
  formatEmailText,
  MSG_MAX_RECIPIENTS,
  parseMsg,
  stripHtml,
} from "@/lib/knowledge/msg-extract";
import { OfficeFileRejectedError } from "@/lib/knowledge/office-formats";
import { buildMsg } from "@/test-helpers/msg-fixture";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-kb-msg-extract-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function write(name: string, bytes: Buffer): string {
  const path = join(tmpRoot, name);
  writeFileSync(path, bytes);
  return path;
}

const OFFER = {
  subject: "Angebot Prüfstand – Größe 3",
  body: "Sehr geehrte Damen und Herren,\n\nanbei unser Angebot über 12 Stück.\n\nMit freundlichen Grüßen",
  senderName: "Jörg Müller",
  senderEmail: "j.mueller@lieferant.example",
  recipients: [
    { name: "Einkauf", email: "einkauf@firma.example", type: "to" as const },
    { name: "Anna Weiß", email: "a.weiss@firma.example", type: "cc" as const },
    { name: "Archiv", email: "archiv@firma.example", type: "bcc" as const },
  ],
  delivered: new Date(Date.UTC(2026, 10, 3, 9, 15)),
  attachments: [{ name: "Angebot-4711.pdf", data: Buffer.from("%PDF-1.4") }],
};

describe("parseMsg", () => {
  it("reads subject, sender, recipients, date, body and attachment names", async () => {
    const email = await parseMsg(write("Angebot.msg", buildMsg(OFFER)));

    expect(email.subject).toBe(OFFER.subject);
    expect(email.from).toBe("Jörg Müller <j.mueller@lieferant.example>");
    expect(email.to).toEqual(["Einkauf <einkauf@firma.example>"]);
    expect(email.cc).toEqual(["Anna Weiß <a.weiss@firma.example>"]);
    expect(email.date).toBe("2026-11-03 09:15 UTC");
    expect(email.body).toBe(OFFER.body);
    expect(email.attachments).toEqual(["Angebot-4711.pdf"]);
    expect(email.bodyTruncated).toBe(false);
  });

  // A blind copy is the sender's decision that the other recipients must not
  // see this name. The index is read by people who were never on the mail.
  it("leaves BCC recipients out", async () => {
    const email = await parseMsg(write("a.msg", buildMsg(OFFER)));
    expect(JSON.stringify(email)).not.toContain("archiv@firma.example");
  });

  it("reads an HTML-only body as text", async () => {
    const email = await parseMsg(
      write(
        "html.msg",
        buildMsg({
          subject: "Lieferung",
          html: "<html><body><p>Liefertermin:&nbsp;KW&nbsp;47</p><p>Grüße</p></body></html>",
        })
      )
    );
    expect(email.body).toBe("Liefertermin: KW 47\n\nGrüße");
  });

  // Inline images in a signature are attachments to MAPI, but nobody filed
  // them — listing "image001.png" on every mail is noise in every search.
  it("skips hidden attachments", async () => {
    const email = await parseMsg(
      write(
        "sig.msg",
        buildMsg({
          subject: "x",
          body: "y",
          attachments: [
            { name: "image001.png", data: Buffer.from("png"), hidden: true },
            { name: "Lieferschein.pdf", data: Buffer.from("%PDF") },
          ],
        })
      )
    );
    expect(email.attachments).toEqual(["Lieferschein.pdf"]);
  });

  it("caps a long recipient list and says how many it left out", async () => {
    const recipients = Array.from({ length: MSG_MAX_RECIPIENTS + 5 }, (_, i) => ({
      name: `R${i}`,
      email: `r${i}@firma.example`,
      type: "to" as const,
    }));
    const email = await parseMsg(write("all.msg", buildMsg({ subject: "x", recipients })));
    expect(email.to).toHaveLength(MSG_MAX_RECIPIENTS + 1);
    expect(email.to.at(-1)).toBe("and 5 more");
  });

  it("refuses a file that is not a Compound File as unexpected content", async () => {
    const err = await parseMsg(write("fake.msg", Buffer.from("From: a@b\n\nplain mime"))).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(OfficeFileRejectedError);
    expect((err as OfficeFileRejectedError).code).toBe("unexpected_content");
  });

  // A mail cut short by an interrupted copy or a sync client still carries
  // the signature, and the parser then throws RangeError/TypeError from deep
  // inside the Compound File walk. That is a fact about the file, not about
  // the machine: refused, so it lands in the unsearchable list instead of
  // failing again on every run.
  it.each([512, 1024, 512 * 8])(
    "refuses a message truncated to %i bytes as unexpected content",
    async (length) => {
      const whole = buildMsg(OFFER);
      expect(whole.length).toBeGreaterThan(length);
      const err = await parseMsg(write("cut.msg", whole.subarray(0, length))).catch(
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(OfficeFileRejectedError);
      expect((err as OfficeFileRejectedError).code).toBe("unexpected_content");
    }
  );

  it("refuses a file past the size cap before parsing it", async () => {
    const err = await parseMsg(write("big.msg", buildMsg(OFFER)), { maxBytes: 100 }).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(OfficeFileRejectedError);
    expect((err as OfficeFileRejectedError).code).toBe("too_large");
  });

  it("cuts an oversized body and says so", async () => {
    const email = await parseMsg(
      write("long.msg", buildMsg({ subject: "x", body: "a".repeat(50) })),
      {
        maxBodyChars: 10,
      }
    );
    expect(email.body).toBe("a".repeat(10));
    expect(email.bodyTruncated).toBe(true);
  });
});

describe("formatEmailText", () => {
  it("puts the headers a reader searches for above the body", async () => {
    const email = await parseMsg(write("Angebot.msg", buildMsg(OFFER)));
    expect(formatEmailText(email)).toBe(
      [
        "Subject: Angebot Prüfstand – Größe 3",
        "From: Jörg Müller <j.mueller@lieferant.example>",
        "To: Einkauf <einkauf@firma.example>",
        "Cc: Anna Weiß <a.weiss@firma.example>",
        "Date: 2026-11-03 09:15 UTC",
        "Attachments: Angebot-4711.pdf",
        "",
        OFFER.body,
      ].join("\n")
    );
  });

  it("omits headers the message does not have", () => {
    expect(
      formatEmailText({
        subject: "Notiz",
        from: null,
        to: [],
        cc: [],
        date: null,
        body: "Text",
        attachments: [],
        bodyTruncated: false,
      })
    ).toBe("Subject: Notiz\n\nText");
  });
});

describe("emailContextLine", () => {
  // The line is repeated in front of every chunk after the first, outside the
  // reader's fence. A subject the size of the body would multiply into
  // gigabytes across a long mail, so the line has a ceiling of its own.
  it("stays short however long the subject and sender are", () => {
    const line = emailContextLine({
      subject: "s".repeat(1_000_000),
      from: "f".repeat(1_000_000),
      to: [],
      cc: [],
      date: "2026-11-03 09:15 UTC",
      body: "",
      attachments: [],
      bodyTruncated: false,
    });
    expect(line.length).toBeLessThanOrEqual(EMAIL_CONTEXT_LINE_MAX_CHARS);
    expect(line.startsWith("Email: sss")).toBe(true);
    expect(line.endsWith("…")).toBe(true);
  });

  // Every chunk after the first loses the header block; this line is what
  // tells a reader of chunk 4 which mail it came from.
  it("names the mail by subject, sender and date", async () => {
    const email = await parseMsg(write("Angebot.msg", buildMsg(OFFER)));
    expect(emailContextLine(email)).toBe(
      "Email: Angebot Prüfstand – Größe 3 — from Jörg Müller <j.mueller@lieferant.example>, 2026-11-03 09:15 UTC"
    );
  });
});

describe("stripHtml on hostile mail bodies", () => {
  // A mail body is untrusted. Many unclosed openers made lazy regexes rescan
  // the rest of the input from every opener: quadratic. Wall-clock ratios
  // cannot see this reliably (a linear run is below timer noise), so count the
  // work instead: every character String.prototype.indexOf scans. A linear
  // pass scans each character a small constant number of times; a rescan from
  // every opener scans O(n) per opener.
  const scannedChars = (input: string): number => {
    const original = String.prototype.indexOf;
    let total = 0;
    String.prototype.indexOf = function (this: string, needle: string, from = 0) {
      const r = original.call(this, needle, from);
      total += (r === -1 ? this.length : r) - from;
      return r;
    };
    try {
      stripHtml(input);
    } finally {
      String.prototype.indexOf = original;
    }
    return total;
  };

  it.each(["<script ", "<SCRIPT ", "<style ", "<style>", "<script>", "<!-- ", "<a ", "<p "])(
    "scans each character a bounded number of times for %j openers",
    (opener) => {
      const input = opener.repeat(4_000);
      expect(scannedChars(input)).toBeLessThanOrEqual(4 * input.length);
    }
  );

  it("finishes a quarter-megabyte of unclosed openers well inside a coarse ceiling", () => {
    const input = "<script ".repeat(32_000);
    const t = performance.now();
    stripHtml(input);
    expect(performance.now() - t).toBeLessThan(2_000);
  });

  it("still strips scripts, styles, comments and tags", () => {
    expect(
      stripHtml(
        "<p>a</p><script>x<b></script><style>p{}</style><!-- c --><b>b&nbsp;&amp;</b><p>c</p>"
      )
    ).toBe("a\nb &\nc");
  });

  it("keeps text after an unclosed opener", () => {
    expect(stripHtml("hello <script>never closed")).toBe("hello never closed");
    expect(stripHtml("a <!-- open")).toBe("a <!-- open");
    expect(stripHtml("1 < 2 and 3")).toBe("1 < 2 and 3");
  });

  it("recognises <style>/<script> after a character whose lowercase is longer (İ)", () => {
    expect(stripHtml("İstanbul İzmir<style>.a{color:red}</style><p>Hallo</p>")).toBe(
      "İstanbul İzmir\nHallo"
    );
    expect(stripHtml("İ<SCRIPT>alert(1)</SCRIPT>text")).toBe("İ text");
  });

  it("keeps a literal < in text instead of eating up to the next tag", () => {
    expect(stripHtml("1 < 2 and 3<br>4")).toBe("1 < 2 and 3\n4");
    expect(stripHtml("1 < 2 and 3<span>4</span>")).toBe("1 < 2 and 3 4");
  });
});
