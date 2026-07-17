import { describe, it, expectTypeOf } from "vitest";
import type {
  EmailAdapter,
  EmailSummary,
  EmailFull,
  ListOptions,
  SearchOptions,
  ComposeOptions,
  Folder,
} from "../email-adapter.js";
import { ImapAdapter, type ImapAdapterOptions } from "../imap-adapter.js";

describe("EmailAdapter contract", () => {
  it("Folder is the five canonical values", () => {
    expectTypeOf<Folder>().toEqualTypeOf<"INBOX" | "SENT" | "DRAFTS" | "TRASH" | "SPAM">();
  });

  it("SearchOptions has the V1 DSL fields plus the free-text `text` field", () => {
    expectTypeOf<SearchOptions>().toEqualTypeOf<{
      from?: string;
      to?: string;
      subject?: string;
      text?: string;
      unread?: boolean;
      sinceDays?: number;
      folder?: Folder;
      limit?: number;
    }>();
  });

  it("EmailAdapter has the five method signatures", () => {
    expectTypeOf<EmailAdapter["list"]>().toBeFunction();
    expectTypeOf<EmailAdapter["read"]>().toBeFunction();
    expectTypeOf<EmailAdapter["search"]>().toBeFunction();
    expectTypeOf<EmailAdapter["draft"]>().toBeFunction();
    expectTypeOf<EmailAdapter["send"]>().toBeFunction();
  });

  it("EmailFull carries attachment metadata", () => {
    expectTypeOf<EmailFull["attachments"]>().toEqualTypeOf<
      Array<{ id: string; filename: string; mimeType: string; size: number }>
    >();
  });

  it("EmailAdapter has a getAttachment method that downloads attachment bytes", () => {
    expectTypeOf<EmailAdapter["getAttachment"]>().toBeFunction();
    expectTypeOf<EmailAdapter["getAttachment"]>().parameters.toEqualTypeOf<[string, string]>();
    expectTypeOf<EmailAdapter["getAttachment"]>().returns.resolves.toEqualTypeOf<{
      filename: string;
      mimeType: string;
      data: Buffer;
    }>();
  });

  it("ImapAdapter conforms to the EmailAdapter contract (compile-time)", () => {
    const opts: ImapAdapterOptions = {
      imapHost: "imap.example.com",
      imapPort: 993,
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      username: "user@example.com",
      password: "app-pw",
      security: "tls",
    };
    // This assignment fails to compile if ImapAdapter drops or mistypes any
    // EmailAdapter method — the same guard tsc applies to `implements
    // EmailAdapter`, made explicit here so a regression surfaces as a failing
    // contract test rather than a silent interface drift.
    const adapter: EmailAdapter = new ImapAdapter(opts);
    expectTypeOf(adapter).toEqualTypeOf<EmailAdapter>();
  });
});
