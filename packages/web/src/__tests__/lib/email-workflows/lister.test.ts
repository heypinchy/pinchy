// Unit tests for the Inbox Agent mail lister (Brick C). The lister is the
// deterministic seam between a mailbox and the dispatcher: it enumerates
// candidate messages, hydrates each one, and normalizes the provider's raw
// header shapes into the `DispatchableEmail` the dispatcher/filter consume.
//
// It is decoupled from the pinchy-email plugin: the web app never imports the
// plugin's adapters. Instead it depends on a narrow `EmailPort` (search/read)
// that Brick D injects — built from decrypted connection credentials in
// production, an in-memory fake here — exactly as `dispatchEmails` injects
// `RunAgent`.
import { describe, it, expect } from "vitest";

import { listDispatchableEmails } from "@/lib/email-workflows/lister";
import type { EmailPort, EmailReadResult } from "@/lib/email-workflows/lister";

/** In-memory EmailPort: search yields the seeded ids; read returns the seeded message. */
function fakePort(messages: EmailReadResult[]): EmailPort {
  const byId = new Map(messages.map((m) => [m.id, m]));
  return {
    async search() {
      return messages.map((m) => ({ id: m.id }));
    },
    async read(id: string) {
      const msg = byId.get(id);
      if (!msg) throw new Error(`fakePort: unknown id ${id}`);
      return msg;
    },
  };
}

describe("mail lister — listDispatchableEmails", () => {
  it("normalizes a hydrated message: unwraps display names, merges To+Cc, maps mime, parses date", async () => {
    const port = fakePort([
      {
        id: "AAMkAG-provider-id-1",
        from: "Clemens Helm <Clemens.Helm@Example.com>",
        to: "Billing <billing@Acme.test>, ops@acme.test",
        cc: "Archive <archive@Acme.test>",
        subject: "Invoice #42",
        date: "2026-07-10T09:30:00.000Z",
        folder: "INBOX",
        messageIdHeader: "<msg-42@example.com>",
        attachments: [{ mimeType: "application/PDF", filename: "invoice.pdf" }],
      },
    ]);

    const { emails } = await listDispatchableEmails(port, { sinceDays: 14 });

    expect(emails).toEqual([
      {
        providerMessageId: "AAMkAG-provider-id-1",
        messageIdHeader: "<msg-42@example.com>",
        from: "clemens.helm@example.com",
        to: ["billing@acme.test", "ops@acme.test", "archive@acme.test"],
        subject: "Invoice #42",
        folder: "INBOX",
        attachments: [{ contentType: "application/pdf", filename: "invoice.pdf" }],
        receivedAt: new Date("2026-07-10T09:30:00.000Z"),
      },
    ]);
  });

  it("de-duplicates a recipient that appears in both To and Cc", async () => {
    // A message copied to the same address on To and Cc must surface it once —
    // otherwise the filter's toDomain check would see a phantom second recipient.
    const port = fakePort([
      {
        id: "id-dup",
        from: "sender@x.test",
        to: "shared@acme.test",
        cc: "Shared <shared@Acme.test>",
        subject: "s",
        date: "2026-07-10T00:00:00.000Z",
        attachments: [],
      },
    ]);

    const {
      emails: [email],
    } = await listDispatchableEmails(port, {});

    expect(email.to).toEqual(["shared@acme.test"]);
  });

  it("drops blank recipient tokens and yields an empty attachment list", async () => {
    // Empty To/Cc headers must not produce phantom "" recipients, and a message
    // with no attachments must yield [] (the filter's hasAttachment:false path).
    const port = fakePort([
      {
        id: "id-bare",
        from: "solo@x.test",
        to: "",
        cc: "",
        subject: "no recipients, no files",
        date: "2026-07-10T00:00:00.000Z",
        attachments: [],
      },
    ]);

    const {
      emails: [email],
    } = await listDispatchableEmails(port, {});

    expect(email.to).toEqual([]);
    expect(email.attachments).toEqual([]);
    // An absent Message-ID header stays absent (it is not part of the claim key).
    expect(email.messageIdHeader).toBeUndefined();
  });

  it("throws with the raw value on an unparseable date rather than emitting an Invalid Date", async () => {
    // receivedAt flows into the run adapter's `.toISOString()`, which throws on
    // an Invalid Date — fail loudly here, naming the offending message, instead
    // of letting a silent Invalid Date poison a later run.
    const port = fakePort([
      {
        id: "id-baddate",
        from: "sender@x.test",
        to: "r@acme.test",
        cc: "",
        subject: "when?",
        date: "not-a-date",
        attachments: [],
      },
    ]);

    await expect(listDispatchableEmails(port, {})).rejects.toThrow(/"not-a-date".*id-baddate/);
  });

  it("keeps a quoted display name that contains a comma as a single recipient", async () => {
    // RFC 5322 allows commas inside a quoted display name. A naive comma-split
    // would shatter `"Doe, John" <john@..>` into a phantom `"doe` recipient and
    // strand the real address — so the recipient set must respect quoting.
    const port = fakePort([
      {
        id: "id-quoted",
        from: '"Support" <support@x.test>',
        to: '"Doe, John" <john@Acme.test>, jane@acme.test',
        cc: "",
        subject: "s",
        date: "2026-07-10T00:00:00.000Z",
        attachments: [],
      },
    ]);

    const {
      emails: [email],
    } = await listDispatchableEmails(port, {});

    expect(email.to).toEqual(["john@acme.test", "jane@acme.test"]);
  });

  it("splits semicolon-separated recipients (Exchange/Graph legacy)", async () => {
    // Exchange/Graph hand back `;`-separated recipient lists. Splitting on comma
    // alone would collapse them into one garbage "address" token.
    const port = fakePort([
      {
        id: "id-semi",
        from: "sender@x.test",
        to: "a@acme.test; b@acme.test",
        cc: "",
        subject: "s",
        date: "2026-07-10T00:00:00.000Z",
        attachments: [],
      },
    ]);

    const {
      emails: [email],
    } = await listDispatchableEmails(port, {});

    expect(email.to).toEqual(["a@acme.test", "b@acme.test"]);
  });

  it("keeps the whole address when the angle bracket is unterminated", async () => {
    // A corrupt `Display Name <addr` (no closing `>`) must not silently drop its
    // last character — take the rest of the string rather than slice(-1).
    const port = fakePort([
      {
        id: "id-openangle",
        from: "Name <bad@y.test",
        to: "r@acme.test",
        cc: "",
        subject: "s",
        date: "2026-07-10T00:00:00.000Z",
        attachments: [],
      },
    ]);

    const {
      emails: [email],
    } = await listDispatchableEmails(port, {});

    expect(email.from).toBe("bad@y.test");
  });

  it("skips a single unusable message and still returns the rest of the mailbox", async () => {
    // Poison-message isolation. One malformed message must not cost a mailbox its
    // whole pass: `normalize` throws on a bad date, and the sweep's unit-level
    // catch is per (workflow × connection) — so without isolation here, one
    // corrupt mail silently stops every OTHER mail on that connection from ever
    // being dispatched, and parks the workflow in `error` until a human deletes
    // it from the mailbox by hand.
    const port = fakePort([
      {
        id: "id-good-before",
        from: "a@x.test",
        to: "",
        cc: "",
        subject: "A",
        date: "2026-07-10T00:00:00.000Z",
        attachments: [],
      },
      {
        id: "id-poison",
        from: "bad@x.test",
        to: "",
        cc: "",
        subject: "corrupt",
        date: "not-a-date",
        attachments: [],
      },
      {
        id: "id-good-after",
        from: "b@x.test",
        to: "",
        cc: "",
        subject: "B",
        date: "2026-07-11T00:00:00.000Z",
        attachments: [],
      },
    ]);

    const { emails, candidateCount } = await listDispatchableEmails(port, {});

    // The poison message is dropped — never a half-normalized email with an
    // Invalid Date, which would only throw later inside the run adapter.
    expect(emails.map((e) => e.providerMessageId)).toEqual(["id-good-before", "id-good-after"]);
    // …but the dropped candidate still counts: `candidateCount` reflects what
    // `search` returned, so the sweep can see a page was full even after a drop.
    expect(candidateCount).toBe(3);
  });

  it("skips a message whose hydration fails, not just one that fails to normalize", async () => {
    // A provider that 404s or errors on a single message (deleted mid-sweep,
    // server-side corruption) is the same class of failure as a bad date: it is
    // about ONE message, so it must cost exactly that message.
    const port: EmailPort = {
      async search() {
        return [{ id: "id-gone" }, { id: "id-ok" }];
      },
      async read(id) {
        if (id === "id-gone") throw new Error("404 message not found");
        return {
          id: "id-ok",
          from: "b@x.test",
          to: "",
          cc: "",
          subject: "B",
          date: "2026-07-11T00:00:00.000Z",
          attachments: [],
        };
      },
    };

    const { emails } = await listDispatchableEmails(port, {});

    expect(emails.map((e) => e.providerMessageId)).toEqual(["id-ok"]);
  });

  it("throws when EVERY candidate fails — a dead mailbox is not a poison message", async () => {
    // The isolation above must not swallow a broken *mailbox*. Credentials that
    // expire between `search` and `read` fail every hydration; reporting that as
    // an empty inbox would turn a loud `error` status into "nothing new today"
    // and silently stop the workflow. Per-message isolation is for the outlier —
    // when there IS no good message, the failure is the mailbox's.
    const port: EmailPort = {
      async search() {
        return [{ id: "a" }, { id: "b" }];
      },
      async read() {
        throw new Error("401 credentials expired");
      },
    };

    await expect(listDispatchableEmails(port, {})).rejects.toThrow(/401 credentials expired/);
  });

  it("forwards the listing window (sinceDays/folder/limit) to the port and hydrates every candidate in order", async () => {
    // The sweep passes its window down; the lister must forward it verbatim and
    // return one hydrated DispatchableEmail per candidate, preserving order.
    const seen: { sinceDays?: number; folder?: string; limit?: number }[] = [];
    const messages: EmailReadResult[] = [
      {
        id: "a",
        from: "a@x.test",
        to: "",
        cc: "",
        subject: "A",
        date: "2026-07-10T00:00:00.000Z",
        attachments: [],
      },
      {
        id: "b",
        from: "b@x.test",
        to: "",
        cc: "",
        subject: "B",
        date: "2026-07-11T00:00:00.000Z",
        attachments: [],
      },
    ];
    const byId = new Map(messages.map((m) => [m.id, m]));
    const port: EmailPort = {
      async search(opts) {
        seen.push(opts);
        return messages.map((m) => ({ id: m.id }));
      },
      async read(id) {
        return byId.get(id)!;
      },
    };

    const { emails, candidateCount } = await listDispatchableEmails(port, {
      sinceDays: 14,
      folder: "INBOX",
      limit: 50,
    });

    expect(seen).toEqual([{ sinceDays: 14, folder: "INBOX", limit: 50 }]);
    expect(emails.map((e) => e.providerMessageId)).toEqual(["a", "b"]);
    // Every candidate hydrated, so the count matches the returned batch.
    expect(candidateCount).toBe(2);
  });
});
