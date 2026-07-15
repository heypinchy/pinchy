import { describe, it, expect, vi, beforeEach } from "vitest";

const mockInsert = vi.fn();
const mockValues = vi.fn();
// appendAuditLog now chains `.returning({ id, rowHmac })` off `.values(...)`
// and returns the inserted row. `.values()` therefore returns a builder with a
// `.returning()`; this stub echoes the just-inserted rowHmac with a fixed id.
const mockReturning = vi.fn();
// Returns the "previous row" the chain reads inside the transaction. Default:
// no prior row (genesis → prevHmac null).
const mockPrevRow = vi.fn();
// Returns the users-table lookup row used to resolve actorId → auditPseudonym
// for actorType:"user" entries. Default: no matching user (defensive fallback
// path — raw actorId kept, a warning logged).
const mockPseudonymRow = vi.fn();

// appendAuditLog now runs inside db.transaction with an advisory lock and a
// "read the latest row's hmac" select; mock the tx surface it uses. The
// top-level db.select (outside the transaction) is the actorId → pseudonym
// lookup performed before the transaction starts.
vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => mockPseudonymRow(),
      }),
    }),
    transaction: async (cb: (tx: unknown) => unknown) => {
      const tx = {
        execute: vi.fn().mockResolvedValue(undefined),
        select: () => ({
          from: () => ({
            orderBy: () => ({
              limit: () => mockPrevRow(),
            }),
          }),
        }),
        insert: (...args: unknown[]) => {
          mockInsert(...args);
          return { values: mockValues };
        },
      };
      return cb(tx);
    },
  },
}));

const mockGetOrCreateSecret = vi.fn();

vi.mock("@/lib/encryption", () => ({
  getOrCreateSecret: (...args: unknown[]) => mockGetOrCreateSecret(...args),
}));

import {
  appendAuditLog,
  computeRowHmacV1,
  computeRowHmacV2,
  computeRowHmacV3,
  resetAuditPseudonymCache,
  type AuditLogEntry,
} from "@/lib/audit";
import { auditLog } from "@/db/schema";

describe("appendAuditLog", () => {
  const fakeSecret = Buffer.from("a".repeat(64), "hex");

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrCreateSecret.mockReturnValue(fakeSecret);
    mockValues.mockReturnValue({ returning: mockReturning });
    mockReturning.mockImplementation(() => {
      const insertedRow = mockValues.mock.calls.at(-1)?.[0] as { rowHmac?: string } | undefined;
      return Promise.resolve([{ id: 1, rowHmac: insertedRow?.rowHmac ?? null }]);
    });
    mockPrevRow.mockResolvedValue([]); // genesis: no previous row
    mockPseudonymRow.mockResolvedValue([]); // no matching user by default
    resetAuditPseudonymCache();
  });

  it("should insert a row into the audit_log table", async () => {
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "agent.created",
      resource: "agent:abc",
      detail: { name: "Smithers" },
      outcome: "success",
    });

    expect(mockInsert).toHaveBeenCalledWith(auditLog);
    expect(mockValues).toHaveBeenCalledOnce();
  });

  it("returns the inserted row's { id, rowHmac } (INSERT ... RETURNING)", async () => {
    // The verify job folds its own report row into its checkpoint from this
    // return value rather than a follow-up MAX(id) read (race-safe, see
    // audit-verify-job.ts). Prove appendAuditLog surfaces the inserted row.
    const result = await appendAuditLog({
      actorType: "system",
      actorId: "sys-1",
      eventType: "config.changed",
      detail: { setting: "audit_hmac_secret" },
      outcome: "success",
    });

    const insertedRow = mockValues.mock.calls[0][0] as { rowHmac: string };
    expect(result).toEqual({ id: 1, rowHmac: insertedRow.rowHmac });
  });

  it("should request the audit_hmac_secret", async () => {
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "auth.login",
      outcome: "success",
    });

    expect(mockGetOrCreateSecret).toHaveBeenCalledWith("audit_hmac_secret");
  });

  it("should include a valid HMAC in the inserted row", async () => {
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "agent.created",
      resource: "agent:abc",
      detail: { name: "Smithers" },
      outcome: "success",
    });

    const insertedRow = mockValues.mock.calls[0][0];
    expect(insertedRow.rowHmac).toMatch(/^[0-9a-f]{64}$/);
  });

  it("should set a client-side timestamp (not rely on DB default)", async () => {
    const before = new Date();
    await appendAuditLog({
      actorType: "system",
      actorId: "system",
      eventType: "config.changed",
      detail: {},
      outcome: "success",
    });
    const after = new Date();

    const insertedRow = mockValues.mock.calls[0][0];
    expect(insertedRow.timestamp).toBeInstanceOf(Date);
    expect(insertedRow.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(insertedRow.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("should default resource to null when not provided", async () => {
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "auth.login",
      outcome: "success",
    });

    const insertedRow = mockValues.mock.calls[0][0];
    expect(insertedRow.resource).toBeNull();
  });

  it("should default detail to null when not provided", async () => {
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "auth.logout",
      outcome: "success",
    });

    const insertedRow = mockValues.mock.calls[0][0];
    expect(insertedRow.detail).toBeNull();
  });

  it("should truncate large detail objects before inserting", async () => {
    const largeDetail = { data: "x".repeat(3000) };

    await appendAuditLog({
      actorType: "agent",
      actorId: "agent-1",
      eventType: "tool.execute",
      detail: largeDetail,
      outcome: "success",
    });

    const insertedRow = mockValues.mock.calls[0][0];
    const serialized = JSON.stringify(insertedRow.detail);
    expect(serialized.length).toBeLessThanOrEqual(2048);
    expect(insertedRow.detail._truncated).toBe(true);
  });

  it("should pass all fields to the insert", async () => {
    await appendAuditLog({
      actorType: "agent",
      actorId: "agent-42",
      eventType: "tool.denied",
      resource: "tool:odoo_read",
      detail: { reason: "not allowed" },
      outcome: "failure",
    });

    const insertedRow = mockValues.mock.calls[0][0];
    expect(insertedRow.actorType).toBe("agent");
    expect(insertedRow.actorId).toBe("agent-42");
    expect(insertedRow.eventType).toBe("tool.denied");
    expect(insertedRow.resource).toBe("tool:odoo_read");
    expect(insertedRow.detail).toEqual({ reason: "not allowed" });
  });

  it("should write a v2 row with outcome='success' when outcome is provided", async () => {
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "tool.web_search",
      resource: "agent:abc",
      detail: { toolName: "web_search" },
      outcome: "success",
    });

    const inserted = mockValues.mock.calls[0][0];
    expect(inserted.version).toBe(3);
    expect(inserted.outcome).toBe("success");
    expect(inserted.error).toBeNull();
  });

  it("should write a v2 row with outcome='failure' and error when error is provided", async () => {
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "tool.web_search",
      resource: "agent:abc",
      detail: { toolName: "web_search" },
      outcome: "failure",
      error: { message: "Brave API key missing" },
    });

    const inserted = mockValues.mock.calls[0][0];
    expect(inserted.version).toBe(3);
    expect(inserted.outcome).toBe("failure");
    expect(inserted.error).toEqual({ message: "Brave API key missing" });
  });

  it("type system requires outcome on auth.* events", () => {
    // @ts-expect-error - auth.login must include outcome
    const _bad: AuditLogEntry = {
      actorType: "user",
      actorId: "u1",
      eventType: "auth.login",
      detail: {},
    };
    void _bad;
  });

  it("type system requires outcome on agent.created events", () => {
    // @ts-expect-error - agent.created must include outcome
    const _bad: AuditLogEntry = {
      actorType: "user",
      actorId: "u1",
      eventType: "agent.created",
      resource: "agent:abc",
      detail: { name: "X" },
    };
    void _bad;
  });

  it("writes a v2 row for an auth.login with outcome='success'", async () => {
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "auth.login",
      detail: { email: "a@b.c" },
      outcome: "success",
    });
    const inserted = mockValues.mock.calls[0][0];
    expect(inserted.version).toBe(3);
    expect(inserted.outcome).toBe("success");
    expect(inserted.error).toBeNull();
  });

  it("writes a v2 row for an auth.failed with outcome='failure' and error", async () => {
    await appendAuditLog({
      actorType: "system",
      actorId: "system",
      eventType: "auth.failed",
      detail: { email: "a@b.c", reason: "invalid_credentials" },
      outcome: "failure",
      error: { message: "Invalid credentials" },
    });
    const inserted = mockValues.mock.calls[0][0];
    expect(inserted.version).toBe(3);
    expect(inserted.outcome).toBe("failure");
    expect(inserted.error).toEqual({ message: "Invalid credentials" });
  });

  it("writes a v2 row for an agent.created event", async () => {
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "agent.created",
      resource: "agent:abc",
      detail: { name: "Smithers" },
      outcome: "success",
    });
    const inserted = mockValues.mock.calls[0][0];
    expect(inserted.version).toBe(3);
    expect(inserted.outcome).toBe("success");
    expect(inserted.error).toBeNull();
  });

  it("writes a v2 row for a config.changed event", async () => {
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "config.changed",
      detail: { key: "domain" },
      outcome: "success",
    });
    const inserted = mockValues.mock.calls[0][0];
    expect(inserted.version).toBe(3);
    expect(inserted.outcome).toBe("success");
  });

  it("type system requires outcome on tool.* events", () => {
    // @ts-expect-error - tool.* events must include outcome
    const _bad: AuditLogEntry = {
      actorType: "user",
      actorId: "u1",
      eventType: "tool.web_search",
      detail: {},
    };
    void _bad;
  });

  it("hashes v3 rows with computeRowHmacV3 over the stored fields (and not as v1/v2)", async () => {
    // A prior row exists, so this row's prevHmac chains to it.
    mockPrevRow.mockResolvedValueOnce([{ rowHmac: "a".repeat(64) }]);
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "tool.web_search",
      resource: "agent:abc",
      detail: { toolName: "web_search" },
      outcome: "success",
    });
    const inserted = mockValues.mock.calls[0][0];
    expect(inserted.rowHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(inserted.version).toBe(3);
    // The chain link is stored.
    expect(inserted.prevHmac).toBe("a".repeat(64));

    // Pin the writer's HMAC inputs to the verifier's: recompute the HMAC over
    // the EXACT fields that were stored (incl. prevHmac). If appendAuditLog ever
    // hashes a different field set the produced hex is still 64 chars and the
    // shape assertion above stays green — but verifyIntegrity recomputes over
    // the stored fields and would flag every newly-written row as tampered. This
    // round-trip catches that drift at write time.
    const fields = {
      timestamp: inserted.timestamp,
      eventType: inserted.eventType,
      actorType: inserted.actorType,
      actorId: inserted.actorId,
      resource: inserted.resource,
      detail: inserted.detail,
      outcome: inserted.outcome,
      error: inserted.error,
      prevHmac: inserted.prevHmac,
    };
    expect(inserted.rowHmac).toBe(computeRowHmacV3(fakeSecret, fields));
    // A v3 row is NOT hashed like v1 or v2 (version literal + chain link differ).
    expect(inserted.rowHmac).not.toBe(computeRowHmacV1(fakeSecret, fields));
    expect(inserted.rowHmac).not.toBe(computeRowHmacV2(fakeSecret, fields));
  });

  it("chains prevHmac to the rowHmac of the most recent existing row", async () => {
    mockPrevRow.mockResolvedValueOnce([{ rowHmac: "b".repeat(64) }]);
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "auth.login",
      outcome: "success",
    });
    const inserted = mockValues.mock.calls[0][0];
    expect(inserted.prevHmac).toBe("b".repeat(64));
  });

  it("writes a null prevHmac for the genesis row (empty table)", async () => {
    // mockPrevRow defaults to [] (no previous row).
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "auth.login",
      outcome: "success",
    });
    const inserted = mockValues.mock.calls[0][0];
    expect(inserted.prevHmac).toBeNull();
  });

  // `attachment.uploaded` was removed as a dead AuditEventType (see
  // efa9cbc4); `file.upload.staged` is its current surviving analog for "a
  // file was uploaded" — same round-trip intent, real event shape.
  it("accepts file.upload.staged with the required detail shape", async () => {
    await expect(
      appendAuditLog({
        eventType: "file.upload.staged",
        actorType: "user",
        actorId: "user-123",
        resource: "agent-1",
        outcome: "success",
        detail: {
          uploadId: "upload-1",
          filename: "invoice.pdf",
          mimeType: "application/pdf",
          sizeBytes: 245_000,
          contentHash: "abc123",
          agent: { id: "agent-1", name: "Smithers" },
        },
      })
    ).resolves.toBeDefined();
  });

  // ── GDPR crypto-erasure: actorId → auditPseudonym substitution ─────────
  //
  // For actorType:"user" entries, appendAuditLog looks up the user's
  // auditPseudonym and writes THAT into actor_id instead of the raw users.id.
  // The mapping lives in the mutable users row, so deleting the user erases
  // the mapping and makes all future audit rows for them unlinkable, while
  // the (immutable) audit trail itself survives. See schema.ts comment on
  // users.auditPseudonym.

  describe("actorId pseudonym substitution", () => {
    it("substitutes the user's auditPseudonym for actorId when a match is found", async () => {
      mockPseudonymRow.mockResolvedValueOnce([{ auditPseudonym: "pseudo-abc-123" }]);

      await appendAuditLog({
        actorType: "user",
        actorId: "user-1",
        eventType: "auth.login",
        outcome: "success",
      });

      const inserted = mockValues.mock.calls[0][0];
      expect(inserted.actorId).toBe("pseudo-abc-123");
      expect(inserted.actorId).not.toBe("user-1");
    });

    it("computes the rowHmac over the SUBSTITUTED actorId (pseudonym), not the raw id", async () => {
      mockPseudonymRow.mockResolvedValueOnce([{ auditPseudonym: "pseudo-xyz" }]);

      await appendAuditLog({
        actorType: "user",
        actorId: "user-1",
        eventType: "auth.login",
        outcome: "success",
      });

      const inserted = mockValues.mock.calls[0][0];
      const expectedHmac = computeRowHmacV3(fakeSecret, {
        timestamp: inserted.timestamp,
        eventType: inserted.eventType,
        actorType: inserted.actorType,
        actorId: "pseudo-xyz",
        resource: inserted.resource,
        detail: inserted.detail,
        outcome: inserted.outcome,
        error: inserted.error,
        prevHmac: inserted.prevHmac,
      });
      expect(inserted.rowHmac).toBe(expectedHmac);

      // If the HMAC had instead been computed over the raw actorId, it would
      // differ from the stored one — this pins substitution to happen BEFORE
      // hashing, not after.
      const hmacOverRawId = computeRowHmacV3(fakeSecret, {
        timestamp: inserted.timestamp,
        eventType: inserted.eventType,
        actorType: inserted.actorType,
        actorId: "user-1",
        resource: inserted.resource,
        detail: inserted.detail,
        outcome: inserted.outcome,
        error: inserted.error,
        prevHmac: inserted.prevHmac,
      });
      expect(inserted.rowHmac).not.toBe(hmacOverRawId);
    });

    it("does NOT substitute actorId for actorType:'system' entries", async () => {
      await appendAuditLog({
        actorType: "system",
        actorId: "upload-gc",
        eventType: "config.changed",
        detail: { setting: "test" },
        outcome: "success",
      });

      const inserted = mockValues.mock.calls[0][0];
      expect(inserted.actorId).toBe("upload-gc");
      // The users-table lookup must never even run for system actors.
      expect(mockPseudonymRow).not.toHaveBeenCalled();
    });

    it("does NOT substitute actorId for actorType:'agent' entries", async () => {
      await appendAuditLog({
        actorType: "agent",
        actorId: "agent-42",
        eventType: "tool.denied",
        outcome: "failure",
        error: { message: "not allowed" },
      });

      const inserted = mockValues.mock.calls[0][0];
      expect(inserted.actorId).toBe("agent-42");
      expect(mockPseudonymRow).not.toHaveBeenCalled();
    });

    it("falls back to the raw actorId (and warns) when no matching user is found", async () => {
      mockPseudonymRow.mockResolvedValueOnce([]); // no user row
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await appendAuditLog({
        actorType: "user",
        actorId: "ghost-user",
        eventType: "auth.login",
        outcome: "success",
      });

      const inserted = mockValues.mock.calls[0][0];
      expect(inserted.actorId).toBe("ghost-user");
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it("does not crash when the pseudonym lookup itself throws", async () => {
      mockPseudonymRow.mockRejectedValueOnce(new Error("connection reset"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await expect(
        appendAuditLog({
          actorType: "user",
          actorId: "user-1",
          eventType: "auth.login",
          outcome: "success",
        })
      ).resolves.toBeDefined();

      const inserted = mockValues.mock.calls[0][0];
      expect(inserted.actorId).toBe("user-1");
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it("caches userId → pseudonym so a second append for the same user skips the lookup", async () => {
      mockPseudonymRow.mockResolvedValueOnce([{ auditPseudonym: "pseudo-cached" }]);

      await appendAuditLog({
        actorType: "user",
        actorId: "user-1",
        eventType: "auth.login",
        outcome: "success",
      });
      expect(mockPseudonymRow).toHaveBeenCalledTimes(1);

      await appendAuditLog({
        actorType: "user",
        actorId: "user-1",
        eventType: "auth.logout",
        outcome: "success",
      });

      // Second call reused the cache — no second DB lookup.
      expect(mockPseudonymRow).toHaveBeenCalledTimes(1);
      const secondInsert = mockValues.mock.calls[1][0];
      expect(secondInsert.actorId).toBe("pseudo-cached");
    });

    it("does not share cache entries across different userIds", async () => {
      mockPseudonymRow.mockResolvedValueOnce([{ auditPseudonym: "pseudo-a" }]);
      await appendAuditLog({
        actorType: "user",
        actorId: "user-a",
        eventType: "auth.login",
        outcome: "success",
      });

      mockPseudonymRow.mockResolvedValueOnce([{ auditPseudonym: "pseudo-b" }]);
      await appendAuditLog({
        actorType: "user",
        actorId: "user-b",
        eventType: "auth.login",
        outcome: "success",
      });

      expect(mockPseudonymRow).toHaveBeenCalledTimes(2);
      expect(mockValues.mock.calls[0][0].actorId).toBe("pseudo-a");
      expect(mockValues.mock.calls[1][0].actorId).toBe("pseudo-b");
    });

    it("evicts the oldest entry once the cache exceeds its max size (bounded, not unbounded)", async () => {
      // The userId → pseudonym cache must not grow without bound in a
      // long-lived process that serves many distinct users. Shrink the cap to
      // 2 (via the same env-override pattern as AUDIT_VERIFY_INTERVAL_MS) so
      // eviction is exercised deterministically without inserting thousands of
      // entries.
      process.env.AUDIT_PSEUDONYM_CACHE_MAX = "2";
      try {
        mockPseudonymRow.mockResolvedValue([{ auditPseudonym: "p" }]);
        const append = (actorId: string) =>
          appendAuditLog({
            actorType: "user",
            actorId,
            eventType: "auth.login",
            outcome: "success",
          });

        await append("user-a"); // lookup 1 → cache {a}
        await append("user-b"); // lookup 2 → cache {a, b}
        await append("user-c"); // lookup 3 → overflow, evict oldest (a) → {b, c}
        expect(mockPseudonymRow).toHaveBeenCalledTimes(3);

        // user-c is still cached → no fresh lookup.
        await append("user-c");
        expect(mockPseudonymRow).toHaveBeenCalledTimes(3);

        // user-a was evicted → it must be looked up again. An unbounded cache
        // would still hold it and wrongly skip this fourth lookup.
        await append("user-a");
        expect(mockPseudonymRow).toHaveBeenCalledTimes(4);
      } finally {
        delete process.env.AUDIT_PSEUDONYM_CACHE_MAX;
      }
    });
  });
});
