import { describe, it, expectTypeOf } from "vitest";
import type { AuditLogEntry, AuditEventType } from "@/lib/audit";
import type { ProbeFailureCode } from "@/lib/integrations/imap-probe";

// Compile-time type tests. They run under `pnpm -C packages/web typecheck`
// (which type-checks test files); vitest does NOT type-check `expectTypeOf`
// at runtime, so without that gate these assertions are no-ops.
//
// The previous `expectTypeOf(entry.eventType).toEqualTypeOf<AuditEventType>()`
// could never hold — and silently guarded nothing while test files went
// unchecked. `AuditLogEntry["eventType"]` is the broad write-time shape
// (template-literal families like `chat.${string}`, `${AuditResource}.updated`),
// strictly WIDER than the curated flat `AuditEventType` union, so the two are
// not equal by design. These assertions test the relationships that actually
// hold instead.

describe("AuditLogEntry agent.memory_changed", () => {
  it("types the detail shape and keeps the event in the curated union", () => {
    // The detail shape required for an `agent.memory_changed` entry.
    expectTypeOf<
      Extract<AuditLogEntry, { eventType: "agent.memory_changed" }>["detail"]
    >().toEqualTypeOf<{
      agent: { id: string; name: string };
      file: string;
      addedLines: number;
      removedLines: number;
      byteSize: number;
    }>();
    // The event must remain a member of the curated AuditEventType union.
    expectTypeOf<"agent.memory_changed">().toExtend<AuditEventType>();
  });
});

describe("AuditLogEntry channel.auto_disabled (#477 layer 2)", () => {
  it("types the detail shape and keeps the event in the curated union", () => {
    expectTypeOf<
      Extract<AuditLogEntry, { eventType: "channel.auto_disabled" }>["detail"]
    >().toEqualTypeOf<{
      channel: string;
      account: { id: string; name: string | null };
      reason: string;
      lastError: string | null;
    }>();
    expectTypeOf<"channel.auto_disabled">().toExtend<AuditEventType>();
  });
});

describe("AuditLogEntry email_workflow.created (Inbox Agent, #139)", () => {
  it("keeps the event in the curated union", () => {
    // The write side typechecks via the `${AuditResource}.created` template
    // family, which the subset test below can't see in reverse — so pin the
    // membership explicitly, like every other `.created` family.
    expectTypeOf<"email_workflow.created">().toExtend<AuditEventType>();
  });
});

describe("AuditLogEntry email_workflow.updated / .deleted (Automations management)", () => {
  it("keeps the whole CRUD lifecycle in the curated union", () => {
    // The management API (list / enable-disable / delete) rounds out the
    // lifecycle; like agent.*, all three verbs are curated explicitly.
    expectTypeOf<"email_workflow.updated">().toExtend<AuditEventType>();
    expectTypeOf<"email_workflow.deleted">().toExtend<AuditEventType>();
  });
});

describe("AuditLogEntry knowledge.source_viewed (#824)", () => {
  it("types the detail shape without a raw user id", () => {
    // `detail` is stored verbatim — appendAuditLog pseudonymizes the actorId
    // COLUMN only (resolveActorId). A `userId` field here would put a raw
    // users.id into an immutable, HMAC-chained row that crypto-erasure cannot
    // reach, and it duplicates the actor the row already carries. Pinned at
    // compile time so it cannot come back through the type.
    expectTypeOf<
      Extract<AuditLogEntry, { eventType: "knowledge.source_viewed" }>["detail"]
    >().toEqualTypeOf<{
      agent: { id: string; name: string };
      document: { name: string };
      reason?: string;
      partial?: boolean;
    }>();
    expectTypeOf<"knowledge.source_viewed">().toExtend<AuditEventType>();
  });
});

describe("AuditLogEntry knowledge.source_downloaded (#934)", () => {
  it("carries the view row's shape, so the two stay comparable", () => {
    // Taking a copy of a document out of the building is a different act from
    // reading it, which is why it is a different event type — but it is the
    // same access to the same file, so an analyst must be able to ask both
    // questions of one detail shape.
    expectTypeOf<
      Extract<AuditLogEntry, { eventType: "knowledge.source_downloaded" }>["detail"]
    >().toEqualTypeOf<Extract<AuditLogEntry, { eventType: "knowledge.source_viewed" }>["detail"]>();
    expectTypeOf<"knowledge.source_downloaded">().toExtend<AuditEventType>();
  });

  it("stays reachable by narrowing, not just by name", () => {
    // The two are separate union members rather than one member with a union
    // eventType, because `Extract` against a member whose eventType is itself a
    // union yields `never` — silently turning every narrowing caller, and the
    // assertion above, into a check of nothing.
    expectTypeOf<
      Extract<AuditLogEntry, { eventType: "knowledge.source_downloaded" }>
    >().not.toBeNever();
  });
});

describe("AuditLogEntry integration.credentials_tested", () => {
  it("types the detail shape the IMAP test route actually writes", () => {
    // POST /api/integrations/imap/test writes the per-leg failure CODES, not a
    // prose `reason` — a failed probe is only useful in the log if it says
    // which leg failed and how. The route's own annotation now catches a field
    // the type doesn't declare; this assertion covers the other direction, a
    // field the TYPE declares that nothing writes (which is what `reason` was).
    expectTypeOf<
      Extract<AuditLogEntry, { eventType: "integration.credentials_tested" }>["detail"]
    >().toEqualTypeOf<{
      imapHost: string;
      smtpHost: string;
      imapCode?: ProbeFailureCode;
      smtpCode?: ProbeFailureCode;
      emailHash?: string;
      emailPreview?: string;
    }>();
    expectTypeOf<"integration.credentials_tested">().toExtend<AuditEventType>();
  });
});

describe("AuditEventType is a subset of AuditLogEntry['eventType']", () => {
  it("every curated event type is one appendAuditLog can record", () => {
    // Intentionally NOT equal (the entry type is strictly broader), but the
    // curated list must stay a SUBSET of what an entry can carry — otherwise it
    // would advertise an event that appendAuditLog cannot actually write.
    expectTypeOf<AuditEventType>().toExtend<AuditLogEntry["eventType"]>();
  });
});
