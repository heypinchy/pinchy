// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  assertOAuthCredentialsShape,
  assertImapCredentialsShape,
} from "../index";

describe("assertOAuthCredentialsShape", () => {
  it("accepts a payload with a string accessToken", () => {
    expect(() =>
      assertOAuthCredentialsShape({ accessToken: "tok-123" }),
    ).not.toThrow();
  });

  it("throws when accessToken is missing", () => {
    expect(() => assertOAuthCredentialsShape({})).toThrow(/accessToken/);
  });

  it("throws when accessToken is not a string", () => {
    expect(() =>
      assertOAuthCredentialsShape({ accessToken: 12345 }),
    ).toThrow(/must be a string/);
  });

  it("REGRESSION (#209): gives a clear hint for SecretRef-shaped payloads", () => {
    const secretRefLike = {
      source: "file",
      provider: "pinchy",
      id: "/integrations/conn-1/accessToken",
    };
    expect(() => assertOAuthCredentialsShape(secretRefLike)).toThrow(/#209/);
  });

  it("throws when credentials is not an object", () => {
    expect(() => assertOAuthCredentialsShape(null)).toThrow(/object/);
    expect(() => assertOAuthCredentialsShape("nope")).toThrow(/object/);
  });
});

describe("assertImapCredentialsShape", () => {
  const validImap = {
    imapHost: "imap.example.com",
    imapPort: 993,
    smtpHost: "smtp.example.com",
    smtpPort: 587,
    username: "user@example.com",
    password: "app-password",
    security: "tls",
  };

  it("accepts a fully-formed imap credentials payload", () => {
    expect(() => assertImapCredentialsShape(validImap)).not.toThrow();
  });

  it("throws when credentials is not an object", () => {
    expect(() => assertImapCredentialsShape(null)).toThrow(/object/);
  });

  it("throws naming imapHost when missing", () => {
    const { imapHost: _imapHost, ...rest } = validImap;
    expect(() => assertImapCredentialsShape(rest)).toThrow(
      /credentials\.imapHost/,
    );
  });

  it("throws naming imapHost when empty string", () => {
    expect(() =>
      assertImapCredentialsShape({ ...validImap, imapHost: "" }),
    ).toThrow(/credentials\.imapHost/);
  });

  it("throws naming imapPort when not a number", () => {
    expect(() =>
      assertImapCredentialsShape({ ...validImap, imapPort: "993" }),
    ).toThrow(/credentials\.imapPort/);
  });

  it("throws naming smtpHost when missing", () => {
    const { smtpHost: _smtpHost, ...rest } = validImap;
    expect(() => assertImapCredentialsShape(rest)).toThrow(
      /credentials\.smtpHost/,
    );
  });

  it("throws naming smtpPort when not a number", () => {
    expect(() =>
      assertImapCredentialsShape({ ...validImap, smtpPort: "587" }),
    ).toThrow(/credentials\.smtpPort/);
  });

  it("throws naming username when missing", () => {
    const { username: _username, ...rest } = validImap;
    expect(() => assertImapCredentialsShape(rest)).toThrow(
      /credentials\.username/,
    );
  });

  it("throws naming password when missing", () => {
    const { password: _password, ...rest } = validImap;
    expect(() => assertImapCredentialsShape(rest)).toThrow(
      /credentials\.password/,
    );
  });

  it("throws naming security when invalid", () => {
    expect(() =>
      assertImapCredentialsShape({ ...validImap, security: "ssl" }),
    ).toThrow(/credentials\.security/);
  });

  it("throws naming security when missing", () => {
    const { security: _security, ...rest } = validImap;
    expect(() => assertImapCredentialsShape(rest)).toThrow(
      /credentials\.security/,
    );
  });

  it("accepts a valid senderName string", () => {
    expect(() =>
      assertImapCredentialsShape({ ...validImap, senderName: "Clemens Helm" }),
    ).not.toThrow();
  });

  it("accepts credentials without senderName (unchanged behavior)", () => {
    expect(() => assertImapCredentialsShape(validImap)).not.toThrow();
  });

  it("throws naming senderName when present but not a string", () => {
    expect(() =>
      assertImapCredentialsShape({ ...validImap, senderName: 123 }),
    ).toThrow(/credentials\.senderName/);
  });
});
