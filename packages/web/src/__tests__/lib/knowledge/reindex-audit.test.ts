import { describe, expect, it } from "vitest";

import { KB_INDEX_WORKER_ACTOR, reindexAuditEntry } from "@/lib/knowledge/reindex-audit";
import type { IngestResult } from "@/lib/knowledge/types";

const agent = { id: "agent-1", name: "Support Bot" };

const counts: IngestResult = {
  indexed: 3,
  skipped: 5,
  removed: 1,
  unsearchable: 2,
  failed: 1,
  archived: 4,
};

describe("KB_INDEX_WORKER_ACTOR", () => {
  it("is a stable, human-readable system actor id", () => {
    expect(KB_INDEX_WORKER_ACTOR).toBe("kb-index-worker");
  });
});

describe("reindexAuditEntry", () => {
  it("builds a request row for a synchronous no-op (nothing granted)", () => {
    const entry = reindexAuditEntry({
      actorType: "user",
      actorId: "user-1",
      agent,
      outcome: "success",
      pathCount: 0,
    });

    expect(entry).toEqual({
      actorType: "user",
      actorId: "user-1",
      eventType: "knowledge.reindex",
      resource: "agent:agent-1",
      outcome: "success",
      detail: {
        agent,
        pathCount: 0,
      },
    });
  });

  it("omits jobId, counts, and reason entirely rather than writing them as undefined", () => {
    const entry = reindexAuditEntry({
      actorType: "user",
      actorId: "user-1",
      agent,
      outcome: "success",
      pathCount: 0,
    });

    expect(Object.keys(entry.detail as object)).toEqual(["agent", "pathCount"]);
  });

  it("builds a request-rejection row with a reason but no jobId or counts (rejected before enqueue)", () => {
    const entry = reindexAuditEntry({
      actorType: "user",
      actorId: "user-1",
      agent,
      outcome: "failure",
      pathCount: 12,
      reason: "embedding_model_missing",
    });

    expect(entry.outcome).toBe("failure");
    expect(entry.detail).toEqual({
      agent,
      pathCount: 12,
      reason: "embedding_model_missing",
    });
  });

  it("builds a request-rejection row with a jobId when blocked by an already-running job", () => {
    const entry = reindexAuditEntry({
      actorType: "user",
      actorId: "user-1",
      agent,
      outcome: "failure",
      pathCount: 12,
      jobId: "job-1",
      reason: "index_job_already_running",
    });

    expect(entry.detail).toEqual({
      agent,
      pathCount: 12,
      jobId: "job-1",
      reason: "index_job_already_running",
    });
  });

  it("builds a successful request-acceptance row with a jobId and no counts (nothing has run yet)", () => {
    const entry = reindexAuditEntry({
      actorType: "user",
      actorId: "user-1",
      agent,
      outcome: "success",
      pathCount: 12,
      jobId: "job-1",
    });

    expect(entry.detail).toEqual({
      agent,
      pathCount: 12,
      jobId: "job-1",
    });
  });

  it("builds a worker outcome row with counts copied field by field, signed by the system actor", () => {
    const entry = reindexAuditEntry({
      actorType: "system",
      actorId: KB_INDEX_WORKER_ACTOR,
      agent,
      outcome: "success",
      pathCount: 16,
      jobId: "job-1",
      counts,
    });

    expect(entry).toEqual({
      actorType: "system",
      actorId: "kb-index-worker",
      eventType: "knowledge.reindex",
      resource: "agent:agent-1",
      outcome: "success",
      detail: {
        agent,
        pathCount: 16,
        jobId: "job-1",
        indexed: 3,
        skipped: 5,
        removed: 1,
        unsearchable: 2,
        failed: 1,
        archived: 4,
      },
    });
  });

  it("builds a worker failure outcome row with both counts and a scrubbed reason", () => {
    const entry = reindexAuditEntry({
      actorType: "system",
      actorId: KB_INDEX_WORKER_ACTOR,
      agent,
      outcome: "failure",
      pathCount: 16,
      jobId: "job-1",
      counts,
      reason: "embed_failed",
    });

    expect(entry.detail).toEqual({
      agent,
      pathCount: 16,
      jobId: "job-1",
      indexed: 3,
      skipped: 5,
      removed: 1,
      unsearchable: 2,
      failed: 1,
      archived: 4,
      reason: "embed_failed",
    });
  });

  it("never writes filesystem paths into detail, even when counts and a reason are both present", () => {
    const entry = reindexAuditEntry({
      actorType: "system",
      actorId: KB_INDEX_WORKER_ACTOR,
      agent,
      outcome: "failure",
      pathCount: 16,
      jobId: "job-1",
      counts,
      reason: "embed_failed",
    });

    const serialized = JSON.stringify(entry.detail);
    expect(serialized).not.toMatch(/\.pdf|\.docx|\/data\//);
  });
});
