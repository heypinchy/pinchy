// Unit tests for the deterministic email-filter predicate (Inbox Agent #139,
// dispatcher Slice D). `matchesFilter` is the pure gate the dispatcher runs
// before claiming an email: no LLM, no I/O — see design §6. Semantics: AND
// across fields, OR within an array field, all string comparisons
// case-insensitive; an unset or empty field is no constraint.
import { describe, it, expect } from "vitest";

import { matchesFilter } from "@/lib/email-workflows/match";
import type { DispatchableEmail } from "@/lib/email-workflows/types";

function email(overrides: Partial<DispatchableEmail> = {}): DispatchableEmail {
  return {
    providerMessageId: "msg-1",
    from: "alice@vendor.com",
    to: ["accounting@acme.com"],
    subject: "Invoice 4711 for July",
    folder: "INBOX",
    attachments: [{ contentType: "application/pdf", filename: "invoice.pdf" }],
    receivedAt: new Date("2026-07-14T09:00:00Z"),
    ...overrides,
  };
}

describe("matchesFilter", () => {
  it("matches any email when the filter is empty", () => {
    expect(matchesFilter(email(), {})).toBe(true);
  });

  it("matches from on any listed sender, case-insensitively", () => {
    expect(matchesFilter(email(), { from: ["bob@x.com", "ALICE@VENDOR.COM"] })).toBe(true);
    expect(matchesFilter(email(), { from: ["bob@x.com"] })).toBe(false);
  });

  it("matches toDomain when any recipient is in one of the domains", () => {
    expect(
      matchesFilter(email({ to: ["ceo@other.com", "ap@acme.com"] }), { toDomain: ["acme.com"] })
    ).toBe(true);
    expect(matchesFilter(email({ to: ["ceo@other.com"] }), { toDomain: ["acme.com"] })).toBe(false);
  });

  it("matches subjectContains on any listed substring, case-insensitively", () => {
    expect(matchesFilter(email(), { subjectContains: ["quote", "invoice"] })).toBe(true);
    expect(matchesFilter(email(), { subjectContains: ["receipt"] })).toBe(false);
  });

  it("matches hasAttachment against the presence of attachments", () => {
    expect(matchesFilter(email(), { hasAttachment: true })).toBe(true);
    expect(matchesFilter(email({ attachments: [] }), { hasAttachment: true })).toBe(false);
    expect(matchesFilter(email({ attachments: [] }), { hasAttachment: false })).toBe(true);
    expect(matchesFilter(email(), { hasAttachment: false })).toBe(false);
  });

  it("matches attachmentType when any attachment has that content type", () => {
    expect(matchesFilter(email(), { attachmentType: "application/pdf" })).toBe(true);
    expect(matchesFilter(email(), { attachmentType: "image/png" })).toBe(false);
  });

  it("matches folder case-insensitively", () => {
    expect(matchesFilter(email(), { folder: "inbox" })).toBe(true);
    expect(matchesFilter(email(), { folder: "Archive" })).toBe(false);
  });

  it("ANDs across fields — one failing field rejects the whole filter", () => {
    // subject matches, but sender does not → overall reject.
    expect(matchesFilter(email(), { subjectContains: ["invoice"], from: ["nobody@x.com"] })).toBe(
      false
    );
    // both hold → accept.
    expect(
      matchesFilter(email(), { subjectContains: ["invoice"], from: ["alice@vendor.com"] })
    ).toBe(true);
  });

  it("treats an empty array field as no constraint, not match-nothing", () => {
    expect(matchesFilter(email(), { from: [], subjectContains: [] })).toBe(true);
  });
});
