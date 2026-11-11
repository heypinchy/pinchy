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
  emailContextLine,
  formatEmailText,
  MSG_MAX_RECIPIENTS,
  parseMsg,
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
  // Every chunk after the first loses the header block; this line is what
  // tells a reader of chunk 4 which mail it came from.
  it("names the mail by subject, sender and date", async () => {
    const email = await parseMsg(write("Angebot.msg", buildMsg(OFFER)));
    expect(emailContextLine(email)).toBe(
      "Email: Angebot Prüfstand – Größe 3 — from Jörg Müller <j.mueller@lieferant.example>, 2026-11-03 09:15 UTC"
    );
  });
});
