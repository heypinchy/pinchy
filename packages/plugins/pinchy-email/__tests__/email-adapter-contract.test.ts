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

describe("EmailAdapter contract", () => {
  it("Folder is the five canonical values", () => {
    expectTypeOf<Folder>().toEqualTypeOf<"INBOX" | "SENT" | "DRAFTS" | "TRASH" | "SPAM">();
  });

  it("SearchOptions has only the V1 DSL fields", () => {
    expectTypeOf<SearchOptions>().toEqualTypeOf<{
      from?: string;
      to?: string;
      subject?: string;
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
});
