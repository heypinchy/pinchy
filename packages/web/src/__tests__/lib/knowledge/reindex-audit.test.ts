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
    });

    expect(entry.detail).not.toHaveProperty("ocr");
  });
});
