/**
 * The kb_index_jobs store: the queue behind the async reindex (#714).
 *
 * Exercised against a real Postgres because the two properties that matter are
 * enforced by the database, not by application code: only one index job per org
 * may be active at a time (partial unique index), and a claim is an atomic
 * conditional UPDATE. Both are invisible to a mocked test.
 */
import { beforeEach, describe, it, expect } from "vitest";
import { db } from "@/db";
import { agents, kbIndexJobs } from "@/db/schema";
import {
  claimNextIndexJob,
  enqueueIndexJob,
  finishIndexJob,
  getLatestIndexJobForAgent,
  recordIndexJobProgress,
  requeueOrphanedIndexJobs,
} from "@/lib/knowledge/index-jobs";

const ORG_ID = "org-index-jobs-test";

async function makeAgent(name = "Smithers") {
  const [agent] = await db
    .insert(agents)
    .values({ name, model: "test-model", greetingMessage: "Hi" })
    .returning();
  return agent;
}

function enqueueArgs(
  agentId: string,
  overrides: Partial<Parameters<typeof enqueueIndexJob>[0]> = {}
) {
  return {
    orgId: ORG_ID,
    agentId,
    agentName: "Smithers",
    paths: ["/data/hr"],
    requestedBy: "admin-1",
    ...overrides,
  };
}

describe("kb index job store", () => {
  beforeEach(async () => {
    await db.delete(kbIndexJobs);
  });

  it("enqueues a pending job carrying the scope the worker needs to run it", async () => {
    const agent = await makeAgent();

    const result = await enqueueIndexJob(
      enqueueArgs(agent.id, { paths: ["/data/hr", "/data/legal"] })
    );

    expect(result.status).toBe("queued");
    expect(result.job.status).toBe("pending");
    // The worker never re-derives scope from the agent: paths are resolved (and
    // permission-narrowed) at enqueue time, so a grant revoked mid-queue can't
    // widen what a job already in flight indexes.
    expect(result.job.paths).toEqual(["/data/hr", "/data/legal"]);
    expect(result.job.requestedBy).toBe("admin-1");
    expect(result.job.processed).toBe(0);
    expect(result.job.total).toBeNull();
    expect(result.job.startedAt).toBeNull();
  });

  // The index is corpus-wide and embedding is CPU-bound on a 1.5-core
  // container: two concurrent runs would race on the same (org, content_hash)
  // rows and thrash the CPU for no gain. Serializing per org is the point of
  // the partial unique index, and a second enqueue must say so rather than
  // silently dropping the request or queueing a duplicate.
  it("refuses a second active job for the org and hands back the one already in flight", async () => {
    const agentA = await makeAgent("Agent A");
    const agentB = await makeAgent("Agent B");

    const first = await enqueueIndexJob(enqueueArgs(agentA.id));
    const second = await enqueueIndexJob(enqueueArgs(agentB.id, { agentName: "Agent B" }));

    expect(second.status).toBe("busy");
    // The caller gets the blocking job, not a bare rejection — it is the job
    // they have to wait on, so it is the job they must be able to poll.
    expect(second.job.id).toBe(first.job.id);
    expect(second.job.agentId).toBe(agentA.id);

    expect(await db.select().from(kbIndexJobs)).toHaveLength(1);
  });

  it("blocks a second enqueue while the first is running, not merely while it is pending", async () => {
    const agent = await makeAgent();
    await enqueueIndexJob(enqueueArgs(agent.id));
    await claimNextIndexJob();

    const second = await enqueueIndexJob(enqueueArgs(agent.id));

    expect(second.status).toBe("busy");
    expect(second.job.status).toBe("running");
  });

  it("lets the next job through once the previous one has finished", async () => {
    const agent = await makeAgent();
    const first = await enqueueIndexJob(enqueueArgs(agent.id));
    const claimed = await claimNextIndexJob();
    await finishIndexJob(claimed!.id, { outcome: "succeeded", counts: zeroCounts() });

    const second = await enqueueIndexJob(enqueueArgs(agent.id));

    expect(second.status).toBe("queued");
    expect(second.job.id).not.toBe(first.job.id);
  });

  it("claims a pending job exactly once", async () => {
    const agent = await makeAgent();
    await enqueueIndexJob(enqueueArgs(agent.id));

    const claimed = await claimNextIndexJob();
    expect(claimed?.status).toBe("running");
    expect(claimed?.startedAt).toBeInstanceOf(Date);

    // Claimed jobs are not re-claimable: the conditional UPDATE is what stops
    // an overlapping worker tick from running the same corpus twice.
    expect(await claimNextIndexJob()).toBeNull();
  });

  it("claims the oldest pending job first", async () => {
    const agent = await makeAgent();
    const first = await enqueueIndexJob(enqueueArgs(agent.id));
    const claimed = await claimNextIndexJob();
    await finishIndexJob(claimed!.id, { outcome: "succeeded", counts: zeroCounts() });
    const second = await enqueueIndexJob(enqueueArgs(agent.id));
    const finished = await claimNextIndexJob();
    await finishIndexJob(finished!.id, { outcome: "succeeded", counts: zeroCounts() });

    expect(claimed!.id).toBe(first.job.id);
    expect(finished!.id).toBe(second.job.id);
  });

  it("returns null when there is nothing to claim", async () => {
    expect(await claimNextIndexJob()).toBeNull();
  });

  // Progress and findings land in ONE write, because they answer two questions
  // an operator asks at the same moment: how far along is it, and is it going
  // well? A run at 7/42 that has already found 5 unsearchable files is a corpus
  // problem worth seeing now, not after the remaining 35.
  it("records discovery total, per-file progress, and the findings so far", async () => {
    const agent = await makeAgent();
    await enqueueIndexJob(enqueueArgs(agent.id));
    const job = await claimNextIndexJob();

    await recordIndexJobProgress(job!.id, { processed: 0, total: 42, counts: zeroCounts() });
    await recordIndexJobProgress(job!.id, {
      processed: 7,
      total: 42,
      counts: { ...zeroCounts(), indexed: 2, unsearchable: 5 },
    });

    const latest = await getLatestIndexJobForAgent(agent.id);
    expect(latest).toMatchObject({ processed: 7, total: 42, status: "running" });
    expect(latest?.counts).toEqual({ ...zeroCounts(), indexed: 2, unsearchable: 5 });
  });

  it("records the findings and the terminal status when a job succeeds", async () => {
    const agent = await makeAgent();
    await enqueueIndexJob(enqueueArgs(agent.id));
    const job = await claimNextIndexJob();

    const counts = { indexed: 4, skipped: 2, removed: 1, unsearchable: 3, failed: 1 };
    await finishIndexJob(job!.id, { outcome: "succeeded", counts });

    const latest = await getLatestIndexJobForAgent(agent.id);
    expect(latest?.status).toBe("succeeded");
    expect(latest?.counts).toEqual(counts);
    expect(latest?.error).toBeNull();
    expect(latest?.finishedAt).toBeInstanceOf(Date);
  });

  // A systemic failure (embedding endpoint down) still processed some files
  // before it died. Those counts are the operator's only evidence of how far
  // the run got, so a failure must not throw them away.
  it("keeps the partial findings when a job fails", async () => {
    const agent = await makeAgent();
    await enqueueIndexJob(enqueueArgs(agent.id));
    const job = await claimNextIndexJob();

    await finishIndexJob(job!.id, {
      outcome: "failed",
      counts: { indexed: 2, skipped: 0, removed: 0, unsearchable: 0, failed: 0 },
      error: "connect ECONNREFUSED ollama.local:11434",
    });

    const latest = await getLatestIndexJobForAgent(agent.id);
    expect(latest?.status).toBe("failed");
    expect(latest?.counts).toMatchObject({ indexed: 2 });
    expect(latest?.error).toContain("ECONNREFUSED");
    expect(latest?.finishedAt).toBeInstanceOf(Date);
  });

  // Exactly one web container runs the worker, so any job still marked
  // `running` at boot belongs to a process that no longer exists — nothing
  // else could be holding it. Ingest is content-hash idempotent, so requeueing
  // costs a re-discovery and nothing more.
  it("requeues jobs orphaned by a crash so a restart resumes them", async () => {
    const agent = await makeAgent();
    await enqueueIndexJob(enqueueArgs(agent.id));
    const job = await claimNextIndexJob();
    await recordIndexJobProgress(job!.id, {
      processed: 30,
      total: 42,
      counts: { ...zeroCounts(), indexed: 30 },
    });

    const requeued = await requeueOrphanedIndexJobs();

    expect(requeued).toBe(1);
    const latest = await getLatestIndexJobForAgent(agent.id);
    expect(latest?.status).toBe("pending");
    // Progress AND findings reset, because discovery re-runs from the top.
    // Reporting 30/42 for a run that restarted at zero would be the same
    // "processed ≠ real" lie the counters exist to prevent — and leaving
    // `indexed: 30` next to `processed: 0` would be a row contradicting itself.
    expect(latest).toMatchObject({ processed: 0, total: null, startedAt: null });
    expect(latest?.counts).toBeNull();
    expect(await claimNextIndexJob()).not.toBeNull();
  });

  it("leaves finished jobs alone when requeueing orphans", async () => {
    const agent = await makeAgent();
    await enqueueIndexJob(enqueueArgs(agent.id));
    const job = await claimNextIndexJob();
    await finishIndexJob(job!.id, { outcome: "succeeded", counts: zeroCounts() });

    expect(await requeueOrphanedIndexJobs()).toBe(0);
    expect((await getLatestIndexJobForAgent(agent.id))?.status).toBe("succeeded");
  });

  it("reports the most recent job for the agent, and nothing for an agent that never ran one", async () => {
    const agent = await makeAgent();
    const other = await makeAgent("Other");

    await enqueueIndexJob(enqueueArgs(agent.id));
    const first = await claimNextIndexJob();
    await finishIndexJob(first!.id, { outcome: "succeeded", counts: zeroCounts() });
    const second = await enqueueIndexJob(enqueueArgs(agent.id));

    expect((await getLatestIndexJobForAgent(agent.id))?.id).toBe(second.job.id);
    expect(await getLatestIndexJobForAgent(other.id)).toBeNull();
  });
});

function zeroCounts() {
  return { indexed: 0, skipped: 0, removed: 0, unsearchable: 0, failed: 0 };
}
