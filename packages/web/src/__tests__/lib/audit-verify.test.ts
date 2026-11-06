import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockLimit, mockOrderBy, mockWhere, mockFrom, mockSelect, gtCursors, ltBounds } = vi.hoisted(
  () => {
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
    // Records the bound passed to `lt(auditLog.id, …)`. Only the predecessor
    // lookup (isActiveKeySeenBefore) uses lt, so this pins which row it reads.
    const ltBounds: unknown[] = [];
    return { mockLimit, mockOrderBy, mockWhere, mockFrom, mockSelect, gtCursors, ltBounds };
  }
);

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
    lt: (col: unknown, val: unknown) => {
      ltBounds.push(val);
      return (actual.lt as (c: unknown, v: unknown) => unknown)(col, val);
    },
  };
});

import {
  computeRowHmacV1,
  computeRowHmacV2,
  computeRowHmacV3,
  isActiveKeySeenBefore,
  keyChangeSeenAfter,
  readAuditRowKey,
  verifyIntegrity,
} from "@/lib/audit";
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

      // The incremental sweep stores the rowHmac of its checkpoint row. When
      // that row has since vanished or changed, the first row's stored link
      // still matches the remembered value, so seedPrevHmac alone can't see
      // it. The caller knows, and says so with seedPredecessorBroken.
      it("seedPredecessorBroken: flags the first row as a chain break even though its link matches the seed", async () => {
        const seedHmac = "a".repeat(64);
        const r6 = makeV3Entry(6, seedHmac);
        const r7 = makeV3Entry(7, r6.rowHmac);
        mockLimit.mockResolvedValue([r6, r7]);

        const result = await verifyIntegrity(6, 7, {
          seedPrevHmac: seedHmac,
          seedPredecessorBroken: true,
        });

        expect(result.valid).toBe(false);
        expect(result.invalidIds).toEqual([]);
        // Only the boundary link: the rest of the window is intact.
        expect(result.chainBreakIds).toEqual([6]);
      });

      it("seedPredecessorBroken: reports the first row of a legacy (pre-chain) window too", async () => {
        // The break is known from outside the window, not read from the row's
        // own link, so a row version without a link field must not hide it.
        mockLimit.mockResolvedValue([makeEntry(6), makeEntry(7)]);

        const result = await verifyIntegrity(6, 7, {
          seedPrevHmac: "a".repeat(64),
          seedPredecessorBroken: true,
        });

        expect(result.valid).toBe(false);
        expect(result.chainBreakIds).toEqual([6]);
      });

      it("seedPredecessorBroken: reports a first row of unknown version as a chain break too", async () => {
        // A row version no verifier knows is invalid on its own, but the break
        // to its predecessor is known from outside the window and must still be
        // named where the deletion happened.
        const seedHmac = "a".repeat(64);
        const r6 = { ...makeV3Entry(6, seedHmac), version: 99 };
        const r7 = makeV3Entry(7, r6.rowHmac);
        mockLimit.mockResolvedValue([r6, r7]);

        const result = await verifyIntegrity(6, 7, {
          seedPrevHmac: seedHmac,
          seedPredecessorBroken: true,
        });

        expect(result.valid).toBe(false);
        expect(result.invalidIds).toEqual([6]);
        expect(result.chainBreakIds).toEqual([6]);
      });

      it("seedPredecessorBroken: marks only the first row of the window, not the first row of each page", async () => {
        const seedHmac = "a".repeat(64);
        const r6 = makeV3Entry(6, seedHmac);
        const r7 = makeV3Entry(7, r6.rowHmac);
        const r8 = makeV3Entry(8, r7.rowHmac);
        mockLimit.mockResolvedValueOnce([r6, r7]).mockResolvedValueOnce([r8]);

        const result = await verifyIntegrity(6, 8, {
          pageSize: 2,
          seedPrevHmac: seedHmac,
          seedPredecessorBroken: true,
        });

        expect(result.chainBreakIds).toEqual([6]);
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

  function makeV2SignedWith(id: number, signingSecret: Buffer) {
    const fields = {
      timestamp: new Date("2026-02-21T10:00:00Z"),
      eventType: "tool.web_search",
      actorType: "user" as const,
      actorId: `user-${id}`,
      resource: `agent:abc-${id}`,
      detail: { toolName: "web_search" },
      outcome: "success" as "success" | "failure",
      error: null as { message: string } | null,
    };
    return { id, version: 2, ...fields, rowHmac: computeRowHmacV2(signingSecret, fields) };
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

  // The previous key is only trusted for the rows that PRE-date the rotation.
  // The superseded key file stays in the secrets volume, so anyone with DB write
  // access and that key could otherwise re-sign any row — including rows written
  // after the rotation — and still verify. Once a row verifies under the active
  // key, the rotation has happened; no later row may need the old one.
  it("accepts the previous key only as a contiguous prefix: an old-key row after an active-key row is invalid", async () => {
    const r1 = makeV3SignedWith(1, null, previousSecret);
    const r2 = makeV3SignedWith(2, r1.rowHmac, secret);
    // Forged after the rotation by someone holding the old key file.
    const r3 = makeV3SignedWith(3, r2.rowHmac, previousSecret);
    const r4 = makeV3SignedWith(4, r3.rowHmac, secret);
    mockLimit.mockResolvedValue([r1, r2, r3, r4]);

    const result = await verifyIntegrity();

    expect(result.invalidIds).toEqual([3]);
    // The forged row must not be laundered into the "authentic but superseded" bucket.
    expect(result.previousKeyIds).toEqual([1]);
    expect(result.valid).toBe(false);
  });

  it("seedActiveKeySeen: an old-key row is invalid when an earlier window already saw the active key", async () => {
    // An incremental verifier resumes mid-chain and cannot see the rows before
    // its window. Its checkpoint tells it the rotation already happened.
    const r1 = makeV3SignedWith(5, "checkpoint-hmac", previousSecret);
    mockLimit.mockResolvedValue([r1]);

    const result = await verifyIntegrity(5, 5, {
      seedPrevHmac: "checkpoint-hmac",
      seedActiveKeySeen: true,
    });

    expect(result.invalidIds).toEqual([5]);
    expect(result.previousKeyIds).toEqual([]);
    expect(result.valid).toBe(false);
  });

  // The sweep's checkpoint was a row signed under the earlier key, and someone
  // deleted or re-signed it before the first sweep under the new key. The sweep
  // can't tell where the key changed any more, so it closes the old key for the
  // window (seedActiveKeySeen) and the earlier-key rows in it are invalid. The
  // first row's signature therefore fails, and that must not hide the broken
  // link: it is the one finding that says what actually happened.
  it("seedPredecessorBroken: an earlier-key first row after a broken checkpoint is still a chain break", async () => {
    const r5 = makeV3SignedWith(5, "checkpoint-hmac", previousSecret);
    const r6 = makeV3SignedWith(6, r5.rowHmac, previousSecret);
    const r7 = makeV3SignedWith(7, r6.rowHmac, secret);
    mockLimit.mockResolvedValue([r5, r6, r7]);

    const result = await verifyIntegrity(5, 7, {
      seedPrevHmac: "checkpoint-hmac",
      seedActiveKeySeen: true,
      seedPredecessorBroken: true,
    });

    expect(result.chainBreakIds).toEqual([5]);
    // Where the key changed is unknown after the checkpoint broke, so the
    // earlier-key rows can't be confirmed as pre-change history.
    expect(result.invalidIds).toEqual([5, 6]);
    expect(result.previousKeyIds).toEqual([]);
    expect(result.valid).toBe(false);
  });

  it("seedActiveKeySeen: false (or omitted) keeps the previous key acceptable at the window start", async () => {
    const r1 = makeV3SignedWith(5, "checkpoint-hmac", previousSecret);
    mockLimit.mockResolvedValue([r1]);

    const result = await verifyIntegrity(5, 5, {
      seedPrevHmac: "checkpoint-hmac",
      seedActiveKeySeen: false,
    });

    expect(result.previousKeyIds).toEqual([5]);
    expect(result.valid).toBe(true);
  });

  it("keeps the prefix rule across page boundaries", async () => {
    const r1 = makeV3SignedWith(1, null, previousSecret);
    const r2 = makeV3SignedWith(2, r1.rowHmac, secret);
    const r3 = makeV3SignedWith(3, r2.rowHmac, previousSecret);
    mockLimit.mockResolvedValueOnce([r1, r2]).mockResolvedValueOnce([r3]);

    const result = await verifyIntegrity(undefined, undefined, { pageSize: 2 });

    expect(result.invalidIds).toEqual([3]);
    expect(result.previousKeyIds).toEqual([1]);
    expect(result.valid).toBe(false);
  });

  it("does not treat a row that verifies under neither key as the end of the prefix", async () => {
    // A tampered row proves nothing about the rotation having happened, so an
    // authentic old-key row after it is still part of the pre-rotation prefix.
    const tampered = { ...makeV1SignedWith(2, previousSecret), rowHmac: "0".repeat(64) };
    mockLimit.mockResolvedValue([
      makeV1SignedWith(1, previousSecret),
      tampered,
      makeV1SignedWith(3, previousSecret),
      makeV1SignedWith(4, secret),
    ]);

    const result = await verifyIntegrity();

    expect(result.invalidIds).toEqual([2]);
    expect(result.previousKeyIds).toEqual([1, 3]);
  });

  it("treats a chain signed entirely under the previous key as pre-rotation (nothing written since)", async () => {
    const r1 = makeV3SignedWith(1, null, previousSecret);
    const r2 = makeV3SignedWith(2, r1.rowHmac, previousSecret);
    mockLimit.mockResolvedValue([r1, r2]);

    const result = await verifyIntegrity();

    expect(result.invalidIds).toEqual([]);
    expect(result.previousKeyIds).toEqual([1, 2]);
    expect(result.valid).toBe(true);
  });

  describe("readAuditRowKey (which key a stored row verifies under, recomputed now)", () => {
    // select().from().where(eq(id)).limit(1): no orderBy on a point lookup.
    beforeEach(() => {
      mockWhere.mockReturnValue({ orderBy: mockOrderBy, limit: mockLimit });
    });

    it("classifies a row signed under the active key as active", async () => {
      const row = makeV3SignedWith(7, "x".repeat(64), secret);
      mockLimit.mockResolvedValue([row]);

      expect(await readAuditRowKey(7)).toEqual({ key: "active", rowHmac: row.rowHmac });
    });

    it("classifies a row signed under the previous key as previous", async () => {
      // The previous key being known and valid for that row does not make it
      // an active-key row: the question is whether the rotation has happened.
      const row = makeV3SignedWith(7, "x".repeat(64), previousSecret);
      mockLimit.mockResolvedValue([row]);

      expect(await readAuditRowKey(7)).toEqual({ key: "previous", rowHmac: row.rowHmac });
    });

    it("classifies a row that does not exist as missing", async () => {
      mockLimit.mockResolvedValue([]);

      expect(await readAuditRowKey(7)).toEqual({ key: "missing", rowHmac: null });
    });

    it("classifies a row with an unknown version as unknown-version", async () => {
      // Signed under the active key, but a version no verifier knows.
      // verifyIntegrity reports such a row as invalid under every key, so it is
      // kept apart from "neither" rather than read as a key question.
      const row = { ...makeV3SignedWith(7, "x".repeat(64), secret), version: 99 };
      mockLimit.mockResolvedValue([row]);

      expect(await readAuditRowKey(7)).toEqual({ key: "unknown-version", rowHmac: row.rowHmac });
    });

    it("classifies a row whose content changed under an untouched rowHmac as neither", async () => {
      // Content-only tampering: the stored hash string is the one the sweep
      // remembered, but the row no longer verifies under any key.
      const row = { ...makeV3SignedWith(7, "x".repeat(64), secret), detail: {} };
      mockLimit.mockResolvedValue([row]);

      expect(await readAuditRowKey(7)).toEqual({ key: "neither", rowHmac: row.rowHmac });
    });

    it("classifies legacy v1 and v2 rows by the key they verify under, like verifyIntegrity does", async () => {
      // v1/v2 rows are HMAC-signed with the same audit secret; only the payload
      // shape differs. An upgrading install whose checkpoint is a legacy row
      // must not read as tampered.
      const v1 = makeV1SignedWith(7, secret);
      mockLimit.mockResolvedValue([v1]);
      expect(await readAuditRowKey(7)).toEqual({ key: "active", rowHmac: v1.rowHmac });

      const v2 = makeV2SignedWith(8, previousSecret);
      mockLimit.mockResolvedValue([v2]);
      expect(await readAuditRowKey(8)).toEqual({ key: "previous", rowHmac: v2.rowHmac });
    });

    it("classifies a row signed under a key this instance no longer holds as neither", async () => {
      // Second rotation: K1 is the file (the previous key), K2 signed the row,
      // K3 is the active env key. K2 is gone from both places.
      const k2 = Buffer.from("c".repeat(64), "hex");
      const row = makeV3SignedWith(7, "x".repeat(64), k2);
      mockLimit.mockResolvedValue([row]);

      expect(await readAuditRowKey(7)).toEqual({ key: "neither", rowHmac: row.rowHmac });
    });
  });

  describe("keyChangeSeenAfter (seed for the window after a row of that class)", () => {
    it("keeps the previous key open only after a row that positively verifies under it", () => {
      expect(keyChangeSeenAfter("previous")).toBe(false);
      expect(keyChangeSeenAfter("active")).toBe(true);
      // Verifies under no key we hold: either altered after it was verified, or
      // signed by a key retired since. Both mean the change already happened.
      expect(keyChangeSeenAfter("neither")).toBe(true);
      expect(keyChangeSeenAfter("unknown-version")).toBe(true);
    });

    it("answers false when there is no row before (the window starts the chain)", () => {
      expect(keyChangeSeenAfter("missing")).toBe(false);
    });
  });

  describe("isActiveKeySeenBefore (seed for a partial-range verification)", () => {
    beforeEach(() => {
      ltBounds.length = 0;
    });

    it("reads the row directly before fromId", async () => {
      mockLimit.mockResolvedValue([]);

      await isActiveKeySeenBefore(42);

      expect(ltBounds).toEqual([42]);
      expect(mockLimit).toHaveBeenCalledWith(1);
    });

    it("answers true when that row was signed under the active key", async () => {
      mockLimit.mockResolvedValue([makeV3SignedWith(41, "x".repeat(64), secret)]);

      expect(await isActiveKeySeenBefore(42)).toBe(true);
    });

    it("answers false when that row was signed under the previous key", async () => {
      mockLimit.mockResolvedValue([makeV3SignedWith(41, "x".repeat(64), previousSecret)]);

      expect(await isActiveKeySeenBefore(42)).toBe(false);
    });

    it("answers true when that row verifies under neither key", async () => {
      // Only a row that positively verifies under the old key keeps the old key
      // open. A predecessor altered in place (rowHmac untouched) must not re-open
      // it for the whole range.
      const altered = { ...makeV3SignedWith(41, "x".repeat(64), secret), detail: {} };
      mockLimit.mockResolvedValue([altered]);

      expect(await isActiveKeySeenBefore(42)).toBe(true);
    });

    it("answers true when that row has an unknown version", async () => {
      mockLimit.mockResolvedValue([
        { ...makeV3SignedWith(41, "x".repeat(64), previousSecret), version: 99 },
      ]);

      expect(await isActiveKeySeenBefore(42)).toBe(true);
    });

    it("answers false when nothing precedes fromId", async () => {
      mockLimit.mockResolvedValue([]);

      expect(await isActiveKeySeenBefore(1)).toBe(false);
    });
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
