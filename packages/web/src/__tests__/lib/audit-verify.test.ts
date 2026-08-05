import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockLimit, mockOrderBy, mockWhere, mockFrom, mockSelect, gtCursors } = vi.hoisted(() => {
  // verifyIntegrity now keyset-paginates: select().from().where().orderBy().limit().
  // The terminal awaited call is .limit(), so test data is staged on mockLimit.
  const mockLimit = vi.fn();
  const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
  const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
  // Records the cursor passed to each keyset `gt(auditLog.id, cursor)` so tests
  // can assert the cursor actually advances across pages (not just that
  // pagination ran). gt() is only used for the keyset cursor — fromId uses gte,
  // toId uses lte — so this captures exactly the page-to-page progression.
  const gtCursors: unknown[] = [];
  return { mockLimit, mockOrderBy, mockWhere, mockFrom, mockSelect, gtCursors };
});

vi.mock("@/lib/encryption", () => ({
  getOrCreateSecret: vi.fn(() => Buffer.from("a".repeat(64), "hex")),
  // Null by default: no previous signing secret is known, which is every
  // install that never rotated. The rotation suite below opts in.
  getPreviousSecret: vi.fn(() => null),
}));

vi.mock("@/db", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
  },
}));

// Keep real drizzle operators, but tap `gt` to capture the keyset cursor value.
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    gt: (col: unknown, val: unknown) => {
      gtCursors.push(val);
      return (actual.gt as (c: unknown, v: unknown) => unknown)(col, val);
    },
  };
});

import { computeRowHmacV1, computeRowHmacV2, computeRowHmacV3, verifyIntegrity } from "@/lib/audit";
import { getPreviousSecret } from "@/lib/encryption";

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
      previousKeyIds: [],
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
      previousKeyIds: [],
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
      previousKeyIds: [],
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
      previousKeyIds: [],
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
      previousKeyIds: [],
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
        previousKeyIds: [],
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

    describe("seedPrevHmac (boundary-link check for incremental verification)", () => {
      // Incremental callers (e.g. a periodic verify job resuming from a
      // checkpoint) start the window at lastVerifiedId+1. Without a seed, the
      // first row of that window is treated as a chain root and its prevHmac
      // is never compared against anything — exactly the link an attacker
      // could forge without detection. seedPrevHmac closes that gap by
      // supplying the expected prevHmac for the first in-range row.

      it("flags the first row of the window when its prevHmac does not match seedPrevHmac", async () => {
        const r6 = makeV3Entry(6, "tampered-prev-hmac-not-matching-seed".padEnd(64, "0"));
        const r7 = makeV3Entry(7, r6.rowHmac);
        mockLimit.mockResolvedValue([r6, r7]);

        const result = await verifyIntegrity(6, 7, { seedPrevHmac: "f".repeat(64) });

        expect(result.valid).toBe(false);
        expect(result.invalidIds).toEqual([]); // each row's own HMAC still verifies
        expect(result.chainBreakIds).toEqual([6]); // the boundary link itself is broken
      });

      it("does not flag the first row when its prevHmac matches seedPrevHmac", async () => {
        const seedHmac = "a".repeat(64);
        const r6 = makeV3Entry(6, seedHmac);
        const r7 = makeV3Entry(7, r6.rowHmac);
        mockLimit.mockResolvedValue([r6, r7]);

        const result = await verifyIntegrity(6, 7, { seedPrevHmac: seedHmac });

        expect(result.valid).toBe(true);
        expect(result.chainBreakIds).toEqual([]);
      });

      it("checks the boundary link when seedPrevHmac is explicitly null (genesis row)", async () => {
        const r1 = makeV3Entry(1, null);
        const r2 = makeV3Entry(2, r1.rowHmac);
        mockLimit.mockResolvedValue([r1, r2]);

        const result = await verifyIntegrity(1, 2, { seedPrevHmac: null });

        expect(result.valid).toBe(true);
        expect(result.chainBreakIds).toEqual([]);
      });

      it("flags the boundary link when seedPrevHmac is null but the row claims a non-null predecessor", async () => {
        // Models an attacker forging a fake predecessor on what should be the
        // genesis row.
        const r1 = makeV3Entry(1, "forged-predecessor-hmac".padEnd(64, "0"));
        mockLimit.mockResolvedValue([r1]);

        const result = await verifyIntegrity(1, 1, { seedPrevHmac: null });

        expect(result.valid).toBe(false);
        expect(result.chainBreakIds).toEqual([1]);
      });

      it("existing callers without seedPrevHmac keep treating the first row as an unchecked chain root", async () => {
        // Additive/optional: omitting seedPrevHmac must reproduce the
        // pre-existing "first row of a partial range is not chain-checked"
        // behavior exactly.
        const r5 = makeV3Entry(5, "f".repeat(64));
        const r6 = makeV3Entry(6, r5.rowHmac);
        mockLimit.mockResolvedValue([r5, r6]);

        const result = await verifyIntegrity(5, 6);

        expect(result.valid).toBe(true);
        expect(result.chainBreakIds).toEqual([]);
      });
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
      gtCursors.length = 0;

      const result = await verifyIntegrity(undefined, undefined, { pageSize: 2 });

      expect(result).toEqual({
        valid: true,
        totalChecked: 5,
        invalidIds: [],
        chainBreakIds: [],
        previousKeyIds: [],
      });
      // Three pages were actually fetched — the whole table was never loaded
      // at once. (A short final page ends the walk; an exact-multiple table
      // would issue one extra empty fetch.)
      expect(mockSelect).toHaveBeenCalledTimes(3);
      // The cursor genuinely ADVANCES across pages: after page 1 ([r1,r2]) the
      // next fetch asks for id > 2, and after page 2 ([r3,r4]) for id > 4. This
      // guards against a broken refactor that paginates by re-fetching from the
      // same cursor (or never advancing) — which mockSelect-count alone misses.
      expect(gtCursors).toEqual([2, 4]);
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

describe("verifyIntegrity across a signing-secret rotation", () => {
  // An operator who pins AUDIT_HMAC_SECRET after running on the generated file
  // secret leaves a log signed under two keys. Recomputing the older rows under
  // the newer key mismatches every one of them — and `invalidIds` is the bucket
  // audit-trail-verification.mdx defines as "a field inside the row was
  // changed". Reporting a key rotation as tampering is worse than saying
  // nothing, so rows that verify under the known previous secret get their own
  // bucket and never land in `invalidIds`.
  const previousSecret = Buffer.from("b".repeat(64), "hex");

  function makeV1SignedWith(id: number, signingSecret: Buffer) {
    const fields = {
      timestamp: new Date("2026-02-21T10:00:00Z"),
      eventType: "agent.created",
      actorType: "user" as const,
      actorId: `user-${id}`,
      resource: `agent:abc-${id}`,
      detail: { name: "Smithers" },
    };
    return {
      id,
      version: 1,
      outcome: null,
      error: null,
      ...fields,
      rowHmac: computeRowHmacV1(signingSecret, fields),
    };
  }

  function makeV3SignedWith(id: number, prevHmac: string | null, signingSecret: Buffer) {
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
    return { id, version: 3, ...fields, rowHmac: computeRowHmacV3(signingSecret, fields) };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ orderBy: mockOrderBy });
    mockOrderBy.mockReturnValue({ limit: mockLimit });
    vi.mocked(getPreviousSecret).mockReturnValue(previousSecret);
  });

  it("reports rows signed under the previous secret separately, not as tampered", async () => {
    const entries = [
      makeV1SignedWith(1, previousSecret),
      makeV1SignedWith(2, previousSecret),
      makeV1SignedWith(3, secret),
    ];
    mockLimit.mockResolvedValue(entries);

    const result = await verifyIntegrity();

    expect(result.invalidIds).toEqual([]);
    expect(result.previousKeyIds).toEqual([1, 2]);
    // Authentic rows under a superseded key are not an integrity violation.
    expect(result.valid).toBe(true);
  });

  it("keeps the chain intact across the rotation boundary", async () => {
    // The rotation does NOT break the hash chain: prev_hmac stores the
    // predecessor's row_hmac verbatim, whatever key produced it. Only the row
    // signatures change bucket. This is the claim the reference page got wrong.
    const r1 = makeV3SignedWith(1, null, previousSecret);
    const r2 = makeV3SignedWith(2, r1.rowHmac, previousSecret);
    const r3 = makeV3SignedWith(3, r2.rowHmac, secret);
    const r4 = makeV3SignedWith(4, r3.rowHmac, secret);
    mockLimit.mockResolvedValue([r1, r2, r3, r4]);

    const result = await verifyIntegrity();

    expect(result.previousKeyIds).toEqual([1, 2]);
    expect(result.invalidIds).toEqual([]);
    expect(result.chainBreakIds).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("still reports a genuinely tampered row as invalid", async () => {
    // A row that verifies under NEITHER key is tampering, and the previous-key
    // fallback must not launder it.
    const tampered = { ...makeV1SignedWith(2, previousSecret), rowHmac: "0".repeat(64) };
    const entries = [makeV1SignedWith(1, previousSecret), tampered, makeV1SignedWith(3, secret)];
    mockLimit.mockResolvedValue(entries);

    const result = await verifyIntegrity();

    expect(result.invalidIds).toEqual([2]);
    expect(result.previousKeyIds).toEqual([1]);
    expect(result.valid).toBe(false);
  });

  it("reports pre-rotation rows as invalid when no previous secret is available", async () => {
    // The honest limitation: an operator who overwrote the secret FILE has
    // destroyed the old key, and nothing can reclassify those rows.
    vi.mocked(getPreviousSecret).mockReturnValue(null);
    mockLimit.mockResolvedValue([makeV1SignedWith(1, previousSecret), makeV1SignedWith(2, secret)]);

    const result = await verifyIntegrity();

    expect(result.invalidIds).toEqual([1]);
    expect(result.previousKeyIds).toEqual([]);
    expect(result.valid).toBe(false);
  });
});
