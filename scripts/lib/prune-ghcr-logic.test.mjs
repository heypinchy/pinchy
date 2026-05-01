import { test } from "node:test";
import assert from "node:assert/strict";
import { selectVersionsToDelete } from "./prune-ghcr-logic.mjs";

const v = (overrides) => ({
  id: 1,
  created_at: "2026-01-01T00:00:00Z",
  metadata: { container: { tags: [] } },
  ...overrides,
  metadata: {
    container: {
      tags: overrides.tags ?? [],
    },
  },
});

const NOW = new Date("2026-05-01T00:00:00Z");

test("never deletes a version tagged 'latest'", () => {
  const versions = [v({ id: 1, tags: ["latest"] })];
  const result = selectVersionsToDelete(versions, { keepCount: 0, now: NOW });
  assert.deepEqual(result, []);
});

test("never deletes a version tagged 'next'", () => {
  const versions = [v({ id: 1, tags: ["next"] })];
  const result = selectVersionsToDelete(versions, { keepCount: 0, now: NOW });
  assert.deepEqual(result, []);
});

test("never deletes a version tagged with a vX.Y.Z semver", () => {
  const versions = [v({ id: 1, tags: ["v0.4.4"] })];
  const result = selectVersionsToDelete(versions, { keepCount: 0, now: NOW });
  assert.deepEqual(result, []);
});

test("never deletes a version tagged with a vX.Y.Z-prerelease semver", () => {
  const versions = [v({ id: 1, tags: ["v0.4.4-rc.1"] })];
  const result = selectVersionsToDelete(versions, { keepCount: 0, now: NOW });
  assert.deepEqual(result, []);
});

test("never deletes a version that has BOTH sha-* and a protected tag", () => {
  // This is the exact failure mode that motivated this script — a digest
  // tagged with both sha-abc and v0.4.4 must never be considered prunable.
  const versions = [v({ id: 1, tags: ["sha-abcdef123456", "v0.4.4"] })];
  const result = selectVersionsToDelete(versions, { keepCount: 0, now: NOW });
  assert.deepEqual(result, []);
});

test("never deletes untagged versions", () => {
  const versions = [v({ id: 1, tags: [] })];
  const result = selectVersionsToDelete(versions, { keepCount: 0, now: NOW });
  assert.deepEqual(result, []);
});

test("never deletes versions with unrecognised tag shapes", () => {
  // Defensive: if someone manually tagged something weird, leave it alone.
  const versions = [v({ id: 1, tags: ["custom-tag"] })];
  const result = selectVersionsToDelete(versions, { keepCount: 0, now: NOW });
  assert.deepEqual(result, []);
});

test("keeps the N most recent sha-* versions", () => {
  const versions = [
    v({
      id: 1,
      tags: ["sha-aaaaaaaaaaaa"],
      created_at: "2026-04-01T00:00:00Z",
    }),
    v({
      id: 2,
      tags: ["sha-bbbbbbbbbbbb"],
      created_at: "2026-04-02T00:00:00Z",
    }),
    v({
      id: 3,
      tags: ["sha-cccccccccccc"],
      created_at: "2026-04-03T00:00:00Z",
    }),
    v({
      id: 4,
      tags: ["sha-dddddddddddd"],
      created_at: "2026-04-04T00:00:00Z",
    }),
  ];
  const result = selectVersionsToDelete(versions, { keepCount: 2, now: NOW });
  // Two newest are kept (id 4, id 3); the older two should be deleted.
  assert.deepEqual(
    result.map((r) => r.id),
    [2, 1],
  );
});

test("with keepCount >= candidate count, deletes nothing", () => {
  const versions = [
    v({
      id: 1,
      tags: ["sha-aaaaaaaaaaaa"],
      created_at: "2026-04-01T00:00:00Z",
    }),
    v({
      id: 2,
      tags: ["sha-bbbbbbbbbbbb"],
      created_at: "2026-04-02T00:00:00Z",
    }),
  ];
  const result = selectVersionsToDelete(versions, { keepCount: 20, now: NOW });
  assert.deepEqual(result, []);
});

test("with deleteOlderThanDays, only prunes sha-* older than the threshold", () => {
  const versions = [
    // 60 days old → eligible
    v({
      id: 1,
      tags: ["sha-aaaaaaaaaaaa"],
      created_at: "2026-03-02T00:00:00Z",
    }),
    // 10 days old → too young
    v({
      id: 2,
      tags: ["sha-bbbbbbbbbbbb"],
      created_at: "2026-04-21T00:00:00Z",
    }),
  ];
  const result = selectVersionsToDelete(versions, {
    keepCount: 0,
    deleteOlderThanDays: 30,
    now: NOW,
  });
  assert.deepEqual(
    result.map((r) => r.id),
    [1],
  );
});

test("deleteOlderThanDays is applied AFTER keepCount", () => {
  // 5 sha-* versions, all old. keepCount=2 means we keep the 2 newest unconditionally,
  // then the age filter applies to the remaining 3.
  const versions = [
    v({ id: 1, tags: ["sha-1"], created_at: "2026-01-01T00:00:00Z" }),
    v({ id: 2, tags: ["sha-2"], created_at: "2026-01-02T00:00:00Z" }),
    v({ id: 3, tags: ["sha-3"], created_at: "2026-04-25T00:00:00Z" }),
    v({ id: 4, tags: ["sha-4"], created_at: "2026-04-29T00:00:00Z" }),
    v({ id: 5, tags: ["sha-5"], created_at: "2026-04-30T00:00:00Z" }),
  ];
  const result = selectVersionsToDelete(versions, {
    keepCount: 2,
    deleteOlderThanDays: 30,
    now: NOW,
  });
  // Newest two (5, 4) are kept by keepCount.
  // From the rest [3, 2, 1], only id 1 and 2 are >30 days old (id 3 is 6 days old).
  assert.deepEqual(result.map((r) => r.id).sort(), [1, 2]);
});

test("ignores protected versions when applying keepCount", () => {
  // A v0.4.4 release among the candidates must not 'use up' a keep slot;
  // keepCount applies only to sha-* candidates.
  const versions = [
    v({ id: 1, tags: ["v0.4.4"], created_at: "2026-04-30T00:00:00Z" }),
    v({ id: 2, tags: ["sha-aa"], created_at: "2026-04-29T00:00:00Z" }),
    v({ id: 3, tags: ["sha-bb"], created_at: "2026-04-28T00:00:00Z" }),
    v({ id: 4, tags: ["sha-cc"], created_at: "2026-04-27T00:00:00Z" }),
  ];
  const result = selectVersionsToDelete(versions, { keepCount: 2, now: NOW });
  // sha candidates: 2, 3, 4 (newest first). Keep 2 (id 2, 3), delete id 4.
  assert.deepEqual(
    result.map((r) => r.id),
    [4],
  );
});

test("handles empty input", () => {
  const result = selectVersionsToDelete([], { keepCount: 20, now: NOW });
  assert.deepEqual(result, []);
});

test("rejects negative keepCount", () => {
  assert.throws(
    () => selectVersionsToDelete([], { keepCount: -1, now: NOW }),
    /keepCount/i,
  );
});
