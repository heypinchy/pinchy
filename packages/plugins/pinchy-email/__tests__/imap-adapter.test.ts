import { describe, it, expect } from "vitest";
import { ImapAdapter, type ImapAdapterOptions } from "../imap-adapter.js";

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
