import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockLimit, mockOrderBy, mockWhere, mockFrom, mockSelect, mockInsert, mockValues } =
  vi.hoisted(() => {
    // verifyIntegrity now keyset-paginates: select().from().where().orderBy().limit().
    // The terminal awaited call is .limit(), so test data is staged on mockLimit.
    const mockLimit = vi.fn();
    const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
    const mockValues = vi.fn();
    const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
    return { mockLimit, mockOrderBy, mockWhere, mockFrom, mockSelect, mockInsert, mockValues };
  });

vi.mock("@/lib/encryption", () => ({
  getOrCreateSecret: vi.fn(() => Buffer.from("a".repeat(64), "hex")),
}));

vi.mock("@/db", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
  },
}));

import { computeRowHmacV1, computeRowHmacV2, computeRowHmacV3, verifyIntegrity } from "@/lib/audit";

const secret = Buffer.from("a".repeat(64), "hex");

// Build a v3 row whose chain link points at `prevHmac` and whose own rowHmac is
// computed over the full v3 field set (incl. prevHmac).
function makeV3Entry(id: number, prevHmac: string | null) {
  const fields = {
    timestamp: new Date("2026-02-21T10:00:00Z"),
    eventType: "auth.login",
    actorType: "user" as const,
    actorId: `user-${id}`,
    resource: `user:${id}`,
    detail: null,
    outcome: "success" as "success" | "failure",
    error: null as { message: string } | null,
    prevHmac,
  };
  const rowHmac = computeRowHmacV3(secret, fields);
  return { id, version: 3, ...fields, rowHmac };
}

function makeEntry(id: number, overrides?: { tampered?: boolean }) {
  const fields = {
    timestamp: new Date("2026-02-21T10:00:00Z"),
    eventType: "agent.created",
    actorType: "user" as const,
    actorId: `user-${id}`,
    resource: `agent:abc-${id}`,
    detail: { name: "Smithers" },
  };

  const rowHmac = overrides?.tampered
    ? "0000000000000000000000000000000000000000000000000000000000000000"
    : computeRowHmacV1(secret, fields);

  return { id, version: 1, outcome: null, error: null, ...fields, rowHmac };
}

function makeV2Entry(id: number, opts?: { tamperOutcome?: boolean; version?: number }) {
  const fields = {
    timestamp: new Date("2026-02-21T10:00:00Z"),
    eventType: "tool.web_search",
    actorType: "user" as const,
    actorId: `user-${id}`,
    resource: `agent:abc-${id}`,
    detail: { toolName: "web_search" },
    outcome: "failure" as "success" | "failure",
    error: { message: "Brave API key missing" } as { message: string } | null,
  };

  const rowHmac = computeRowHmacV2(secret, fields);

  // Simulate tampering: stored outcome was flipped from "failure" to "success"
  // but the rowHmac was computed against "failure" — verifier recomputes with
  // the stored (tampered) outcome and mismatch follows.
  const storedOutcome = opts?.tamperOutcome ? "success" : fields.outcome;

  return {
    id,
    version: opts?.version ?? 2,
    ...fields,
    outcome: storedOutcome,
    rowHmac,
  };
}

describe("verifyIntegrity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish the chain after clearAllMocks
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ orderBy: mockOrderBy });
    mockOrderBy.mockReturnValue({ limit: mockLimit });
  });

  it("should return valid: true for entries with correct HMACs", async () => {
    const entries = [makeEntry(1), makeEntry(2), makeEntry(3)];
    mockLimit.mockResolvedValue(entries);

    const result = await verifyIntegrity();

    expect(result).toEqual({
      valid: true,
      totalChecked: 3,
      invalidIds: [],
      chainBreakIds: [],
    });
  });

  it("should return valid: false for tampered entries", async () => {
    const entries = [makeEntry(1), makeEntry(2, { tampered: true }), makeEntry(3)];
    mockLimit.mockResolvedValue(entries);

    const result = await verifyIntegrity();

    expect(result).toEqual({
      valid: false,
      totalChecked: 3,
      invalidIds: [2],
      chainBreakIds: [],
    });
  });

  it("should handle fromId and toId range parameters", async () => {
    const entries = [makeEntry(5), makeEntry(6)];
    mockLimit.mockResolvedValue(entries);

    const result = await verifyIntegrity(5, 6);

    expect(result).toEqual({
      valid: true,
      totalChecked: 2,
      invalidIds: [],
      chainBreakIds: [],
    });
    // Verify that where() was called (meaning conditions were applied)
    expect(mockWhere).toHaveBeenCalled();
  });

  it("should return valid: true with totalChecked: 0 for empty result set", async () => {
    mockLimit.mockResolvedValue([]);

    const result = await verifyIntegrity();

    expect(result).toEqual({
      valid: true,
      totalChecked: 0,
      invalidIds: [],
      chainBreakIds: [],
    });
  });

  it("verifies a v1 row hashed with v1 as valid", async () => {
    mockLimit.mockResolvedValue([makeEntry(1)]);
    const result = await verifyIntegrity();
    expect(result.valid).toBe(true);
    expect(result.invalidIds).toEqual([]);
  });

  it("verifies a v2 row hashed with v2 as valid", async () => {
    mockLimit.mockResolvedValue([makeV2Entry(1)]);
    const result = await verifyIntegrity();
    expect(result.valid).toBe(true);
    expect(result.invalidIds).toEqual([]);
  });

  it("flags a v2 row with tampered outcome as invalid", async () => {
    mockLimit.mockResolvedValue([makeV2Entry(7, { tamperOutcome: true })]);
    const result = await verifyIntegrity();
    expect(result.valid).toBe(false);
    expect(result.invalidIds).toEqual([7]);
  });

  it("flags a row with an unknown version as invalid", async () => {
    mockLimit.mockResolvedValue([makeV2Entry(9, { version: 99 })]);
    const result = await verifyIntegrity();
    expect(result.valid).toBe(false);
    expect(result.invalidIds).toEqual([9]);
  });

  it("should detect multiple tampered entries", async () => {
    const entries = [
      makeEntry(1, { tampered: true }),
      makeEntry(2),
      makeEntry(3, { tampered: true }),
    ];
    mockLimit.mockResolvedValue(entries);

    const result = await verifyIntegrity();

    expect(result).toEqual({
      valid: false,
      totalChecked: 3,
      invalidIds: [1, 3],
      chainBreakIds: [],
    });
  });

  describe("v3 hash-chain (deletion / reorder detection)", () => {
    it("validates an intact v3 chain", async () => {
      const r1 = makeV3Entry(1, null);
      const r2 = makeV3Entry(2, r1.rowHmac);
      const r3 = makeV3Entry(3, r2.rowHmac);
      mockLimit.mockResolvedValue([r1, r2, r3]);

      const result = await verifyIntegrity();

      expect(result).toEqual({
        valid: true,
        totalChecked: 3,
        invalidIds: [],
        chainBreakIds: [],
      });
    });

    it("flags a deleted middle row even though every surviving row's HMAC is intact", async () => {
      const r1 = makeV3Entry(1, null);
      const r2 = makeV3Entry(2, r1.rowHmac);
      const r3 = makeV3Entry(3, r2.rowHmac);
      // r2 deleted: r3 still points at r2's hmac, but its predecessor is now r1.
      mockLimit.mockResolvedValue([r1, r3]);

      const result = await verifyIntegrity();

      expect(result.valid).toBe(false);
      expect(result.invalidIds).toEqual([]); // each row's own HMAC still verifies
      expect(result.chainBreakIds).toEqual([3]); // the broken link is detected
    });

    it("flags reordered rows", async () => {
      const r1 = makeV3Entry(1, null);
      const r2 = makeV3Entry(2, r1.rowHmac);
      const r3 = makeV3Entry(3, r2.rowHmac);
      // Rows returned out of chain order (e.g. ids were swapped by an attacker).
      mockLimit.mockResolvedValue([r1, r3, r2]);

      const result = await verifyIntegrity();

      expect(result.valid).toBe(false);
      expect(result.chainBreakIds.length).toBeGreaterThan(0);
    });

    it("does not chain-check the first row of a partial range", async () => {
      // A bounded verify starts mid-chain, so the first row's prevHmac has no
      // in-range predecessor to compare against — it must not be flagged.
      const r5 = makeV3Entry(5, "f".repeat(64));
      const r6 = makeV3Entry(6, r5.rowHmac);
      mockLimit.mockResolvedValue([r5, r6]);

      const result = await verifyIntegrity(5, 6);

      expect(result.valid).toBe(true);
      expect(result.chainBreakIds).toEqual([]);
    });
  });

  describe("keyset pagination (#16: bounded memory)", () => {
    // Serve `rows` in `pageSize`-sized slices on successive .limit() calls, the
    // way a real keyset-paginated query walks the table without ever holding
    // the whole audit_log in memory.
    function servePaged(rows: Array<Record<string, unknown>>, pageSize: number) {
      let offset = 0;
      mockLimit.mockImplementation(() => {
        const slice = rows.slice(offset, offset + pageSize);
        offset += slice.length;
        return Promise.resolve(slice);
      });
    }

    it("walks the table in pages and verifies an intact v3 chain across page boundaries", async () => {
      // Five-row chain, two rows per page → three fetches (2 + 2 + 1). The
      // chain link from row 2→3 and 4→5 spans a page boundary, so this also
      // proves prevRowHmac is carried across pages.
      const r1 = makeV3Entry(1, null);
      const r2 = makeV3Entry(2, r1.rowHmac);
      const r3 = makeV3Entry(3, r2.rowHmac);
      const r4 = makeV3Entry(4, r3.rowHmac);
      const r5 = makeV3Entry(5, r4.rowHmac);
      servePaged([r1, r2, r3, r4, r5], 2);

      const result = await verifyIntegrity(undefined, undefined, { pageSize: 2 });

      expect(result).toEqual({
        valid: true,
        totalChecked: 5,
        invalidIds: [],
        chainBreakIds: [],
      });
      // Three pages were actually fetched — the whole table was never loaded
      // at once. (A short final page ends the walk; an exact-multiple table
      // would issue one extra empty fetch.)
      expect(mockSelect).toHaveBeenCalledTimes(3);
    });

    it("detects a deleted row whose break straddles a page boundary", async () => {
      // r2 deleted. With pageSize 2 the surviving rows page as [r1, r3] then
      // [r4, r5]; the broken link (r3 still points at r2) must be flagged even
      // though r3 is the last row of page 1 and the check needs r1 from the
      // same page.
      const r1 = makeV3Entry(1, null);
      const r2 = makeV3Entry(2, r1.rowHmac);
      const r3 = makeV3Entry(3, r2.rowHmac);
      const r4 = makeV3Entry(4, r3.rowHmac);
      const r5 = makeV3Entry(5, r4.rowHmac);
      servePaged([r1, r3, r4, r5], 2);

      const result = await verifyIntegrity(undefined, undefined, { pageSize: 2 });

      expect(result.valid).toBe(false);
      expect(result.invalidIds).toEqual([]); // each surviving row's own HMAC verifies
      expect(result.chainBreakIds).toEqual([3]);
      expect(result.totalChecked).toBe(4);
    });
  });
});
