/**
 * The `knowledge.reindex` audit entry builder — specifically the shape of what
 * lands on the HMAC-signed row, which is immutable once written.
 */
import { describe, expect, it } from "vitest";

import { KB_INDEX_WORKER_ACTOR, reindexAuditEntry } from "@/lib/knowledge/reindex-audit";

const agent = { id: "agent-1", name: "Smithers" };

describe("the ocr detail", () => {
  it("carries the four documented fields and nothing else", () => {
    // The worker hands over its whole tally, which also carries the token
    // counters the usage row records. The audit docs enumerate exactly
    // `ocr.{model, documents, pages, skippedPages}`, and the builder's own
    // rule (see the `counts` comment) is to copy field by field rather than
    // spread — a spread puts whatever the caller's type grows into onto a row
    // that can never be rewritten.
    const workerTally = {
      model: "anthropic/claude-haiku-4-5-20251001",
      documents: 2,
      pages: 7,
      skippedPages: 1,
      inputTokens: 900,
      outputTokens: 40,
    };

    const entry = reindexAuditEntry({
      actorType: "system",
      actorId: KB_INDEX_WORKER_ACTOR,
      agent,
      outcome: "success",
      pathCount: 1,
      jobId: "job-1",
      trigger: "manual",
      ocr: workerTally,
    });

    expect((entry.detail as Record<string, unknown>).ocr).toEqual({
      model: "anthropic/claude-haiku-4-5-20251001",
      documents: 2,
      pages: 7,
      skippedPages: 1,
    });
  });

  it("is absent when the run sent nothing", () => {
    // Absent, not zeroed: a missing field reads as "nothing was sent", and a
    // zero row would claim we looked on runs that never resolved a model.
    const entry = reindexAuditEntry({
      actorType: "system",
      actorId: KB_INDEX_WORKER_ACTOR,
      agent,
      outcome: "success",
      pathCount: 1,
      jobId: "job-1",
      trigger: "manual",
    });

    expect(entry.detail).not.toHaveProperty("ocr");
  });
});

describe("the trigger", () => {
  // A run nobody asked for is still a run on the record. Whether an admin
  // clicked or the nightly schedule fired is the first question anyone reading
  // the trail asks, and `actorId` only answers it by spelling convention.
  it("says an admin's request was manual", () => {
    const entry = reindexAuditEntry({
      actorType: "user",
      actorId: "admin-1",
      agent,
      outcome: "success",
      pathCount: 1,
      jobId: "job-1",
      trigger: "manual",
    });

    expect(entry.detail).toMatchObject({ trigger: "manual" });
    expect(entry.detail).not.toHaveProperty("sweepId");
  });

  // One night is one sweep across every knowledge-base agent. The sweepId
  // correlates its rows from a single drill-down query, the same contract
  // every batched maintenance operation keeps (AGENTS.md).
  it("ties a scheduled run to the sweep it belongs to", () => {
    const entry = reindexAuditEntry({
      actorType: "system",
      actorId: KB_INDEX_WORKER_ACTOR,
      agent,
      outcome: "success",
      pathCount: 1,
      jobId: "job-1",
      trigger: "scheduled",
      sweepId: "sweep-1",
    });

    expect(entry.detail).toMatchObject({ trigger: "scheduled", sweepId: "sweep-1" });
  });
});
