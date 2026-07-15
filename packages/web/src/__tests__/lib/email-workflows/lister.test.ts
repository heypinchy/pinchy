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

    const emails = await listDispatchableEmails(port, { sinceDays: 14 });

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

    const [email] = await listDispatchableEmails(port, {});

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

    const [email] = await listDispatchableEmails(port, {});

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

    await expect(listDispatchableEmails(port, {})).rejects.toThrow(
      /not-a-date.*id-baddate|id-baddate/
    );
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

    const emails = await listDispatchableEmails(port, {
      sinceDays: 14,
      folder: "INBOX",
      limit: 50,
    });

    expect(seen).toEqual([{ sinceDays: 14, folder: "INBOX", limit: 50 }]);
    expect(emails.map((e) => e.providerMessageId)).toEqual(["a", "b"]);
  });
});
