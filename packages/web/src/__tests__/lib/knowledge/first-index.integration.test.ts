/**
 * The first index an agent gets when it is granted a folder nothing has
 * indexed yet (#1280).
 *
 * Against a real Postgres because every decision here is a question about
 * real rows: which folders a `kb_index_jobs` row already went through, whether
 * the instance's one job slot is taken, and what the audit trail recorded.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { agents, auditLog, kbDocuments, kbIndexJobs } from "@/db/schema";
import type { AuditLogEntry } from "@/lib/audit";
import { DEFAULT_ORG_ID } from "@/lib/knowledge/constants";
import {
  enqueueIndexJob,
  finishIndexJob,
  claimNextIndexJob,
  recordIndexJobProgress,
} from "@/lib/knowledge/index-jobs";
import {
  agentsOwedFirstIndex,
  getFirstIndexStatus,
  neverIndexedPaths,
  queueFirstIndex,
} from "@/lib/knowledge/first-index";

const mockKbEmbedderAvailable = vi.fn(() => true);
vi.mock("@/lib/knowledge/kb-embedder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/knowledge/kb-embedder")>()),
  kbEmbedderAvailable: () => mockKbEmbedderAvailable(),
}));

const ADMIN = { actorType: "user" as const, actorId: "admin-1" };

async function knowledgeAgent(
  paths: string[],
  overrides: Partial<typeof agents.$inferInsert> = {}
) {
  const [agent] = await db
    .insert(agents)
    .values({
      name: "Handbook",
      model: "test-model",
      greetingMessage: "Hi",
      allowedTools: ["knowledge_search"],
      pluginConfig: { "pinchy-files": { allowed_paths: paths } },
      ...overrides,
    })
    .returning();
  return agent;
}

async function finishedJob(agentId: string, paths: string[], outcome: "succeeded" | "failed") {
  const enqueued = await enqueueIndexJob({
    orgId: DEFAULT_ORG_ID,
    agentId,
    agentName: "Handbook",
    requestedBy: "admin-1",
    paths,
  });
  await claimNextIndexJob();
  await finishIndexJob(enqueued.job.id, {
    outcome,
    counts: { indexed: 0, skipped: 0, removed: 0, unsearchable: 0, failed: 0, archived: 0 },
  });
  return enqueued.job;
}

function recorder() {
  const entries: AuditLogEntry[] = [];
  return { entries, audit: (entry: AuditLogEntry) => void entries.push(entry) };
}

beforeEach(async () => {
  await db.delete(kbIndexJobs);
  await db.delete(kbDocuments);
  await db.delete(auditLog);
  mockKbEmbedderAvailable.mockReturnValue(true);
});

describe("neverIndexedPaths", () => {
  it("answers every folder no run has gone through", async () => {
    expect(await neverIndexedPaths(["/data/hr", "/data/legal"])).toEqual([
      "/data/hr",
      "/data/legal",
    ]);
  });

  it("leaves out a folder a run went through, whichever agent it was for and however it ended", async () => {
    const other = await knowledgeAgent(["/data/hr"]);
    await finishedJob(other.id, ["/data/hr"], "failed");

    expect(await neverIndexedPaths(["/data/hr", "/data/legal"])).toEqual(["/data/legal"]);
  });

  it("leaves out a folder inside one a run went through, but not one beside or above it", async () => {
    const other = await knowledgeAgent(["/data/hr"]);
    await finishedJob(other.id, ["/data/hr"], "succeeded");

    expect(await neverIndexedPaths(["/data/hr/policies", "/data/hr-archive", "/data"])).toEqual([
      "/data/hr-archive",
      "/data",
    ]);
  });

  it("counts a run still waiting or going as having it, unless asked for finished runs only", async () => {
    const other = await knowledgeAgent(["/data/hr"]);
    await enqueueIndexJob({
      orgId: DEFAULT_ORG_ID,
      agentId: other.id,
      agentName: "Handbook",
      requestedBy: "admin-1",
      paths: ["/data/hr"],
    });

    expect(await neverIndexedPaths(["/data/hr"])).toEqual([]);
    expect(await neverIndexedPaths(["/data/hr"], { finishedOnly: true })).toEqual(["/data/hr"]);
  });

  it("reads a folder spelled with and without its trailing slash as the same folder", async () => {
    // POST /api/agents stores "/data/hr/", the Permissions tab "/data/hr".
    const created = await knowledgeAgent(["/data/hr/"]);
    await finishedJob(created.id, ["/data/hr/"], "succeeded");
    const other = await knowledgeAgent(["/data/legal"]);
    await finishedJob(other.id, ["/data/legal"], "succeeded");

    expect(await neverIndexedPaths(["/data/hr", "/data/hr/policies", "/data/legal/"])).toEqual([]);
    expect(await neverIndexedPaths(["/data/hr-archive/"])).toEqual(["/data/hr-archive/"]);
  });

  it("judges against runs the caller already read, without reading them again", async () => {
    const runs = { all: ["/data/hr"], finished: ["/data/hr"] };

    expect(await neverIndexedPaths(["/data/hr", "/data/legal"], { runs })).toEqual(["/data/legal"]);
  });

  it("does not count a run finished before the upgrade that emptied the index", async () => {
    // 0056 truncated kb_documents and kb_chunks but kept kb_index_jobs: a
    // v0.9.x run's folder is empty now. Every run that finished since records
    // the artifact format it ran under; those from before carry none.
    const old = await knowledgeAgent(["/data/hr"]);
    const job = await finishedJob(old.id, ["/data/hr"], "succeeded");
    await db
      .update(kbIndexJobs)
      .set({ artifactFormatVersion: null })
      .where(eq(kbIndexJobs.id, job.id));

    expect(await neverIndexedPaths(["/data/hr"])).toEqual(["/data/hr"]);
    expect(await neverIndexedPaths(["/data/hr"], { finishedOnly: true })).toEqual(["/data/hr"]);
  });

  it("takes documents already in the index as indexed when no run explains them", async () => {
    // Rows ingested before runs were recorded as jobs: the folder is in the
    // index, and walking it again would be a full re-read for nothing.
    await db.insert(kbDocuments).values({
      orgId: DEFAULT_ORG_ID,
      sourcePath: "/data/hr/handbook.pdf",
      contentHash: "h",
    });

    expect(await neverIndexedPaths(["/data/hr", "/data/legal"])).toEqual(["/data/legal"]);
  });

  it("does not take a run of a folder inside one as the whole folder's", async () => {
    // Widening a grant from /data/hr to /data: the documents under /data
    // came from the run over /data/hr, and everything beside it is unread.
    const other = await knowledgeAgent(["/data/hr"]);
    await finishedJob(other.id, ["/data/hr"], "succeeded");
    await db.insert(kbDocuments).values({
      orgId: DEFAULT_ORG_ID,
      sourcePath: "/data/hr/handbook.pdf",
      contentHash: "h",
    });

    expect(await neverIndexedPaths(["/data"])).toEqual(["/data"]);
  });
});

describe("queueFirstIndex", () => {
  it("queues a run over the agent's folders, attributed to the admin and audited", async () => {
    const agent = await knowledgeAgent(["/data/hr", "/data/legal"]);
    const { entries, audit } = recorder();

    const outcome = await queueFirstIndex(agent.id, ADMIN, audit);

    expect(outcome.status).toBe("queued");
    const [job] = await db.select().from(kbIndexJobs);
    expect(job).toMatchObject({
      agentId: agent.id,
      status: "pending",
      trigger: "initial",
      requestedBy: "admin-1",
      paths: ["/data/hr", "/data/legal"],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actorType: "user",
      actorId: "admin-1",
      eventType: "knowledge.reindex",
      resource: `agent:${agent.id}`,
      outcome: "success",
      detail: {
        agent: { id: agent.id, name: "Handbook" },
        trigger: "initial",
        jobId: job.id,
        pathCount: 2,
      },
    });
  });

  it("runs only the folders nothing has indexed yet", async () => {
    const agent = await knowledgeAgent(["/data/hr", "/data/legal"]);
    await finishedJob(agent.id, ["/data/hr"], "succeeded");

    await queueFirstIndex(agent.id, ADMIN, recorder().audit);

    const [job] = await db.select().from(kbIndexJobs).where(eq(kbIndexJobs.trigger, "initial"));
    expect(job.paths).toEqual(["/data/legal"]);
  });

  it("queues nothing twice: a second ask finds the first run waiting", async () => {
    const agent = await knowledgeAgent(["/data/hr"]);

    await queueFirstIndex(agent.id, ADMIN, recorder().audit);
    const { entries, audit } = recorder();
    const second = await queueFirstIndex(agent.id, ADMIN, audit);

    expect(second.status).toBe("skipped");
    expect(await db.select().from(kbIndexJobs)).toHaveLength(1);
    expect(entries).toEqual([]);
  });

  it("waits its turn behind a run already going, without recording anything", async () => {
    const other = await knowledgeAgent(["/data/legal"]);
    await enqueueIndexJob({
      orgId: DEFAULT_ORG_ID,
      agentId: other.id,
      agentName: "Legal",
      requestedBy: "admin-1",
      paths: ["/data/legal"],
    });
    const agent = await knowledgeAgent(["/data/hr"]);
    const { entries, audit } = recorder();

    expect((await queueFirstIndex(agent.id, ADMIN, audit)).status).toBe("busy");
    expect(await db.select().from(kbIndexJobs)).toHaveLength(1);
    expect(entries).toEqual([]);
  });

  it("queues nothing for an agent that does not search the index", async () => {
    const reader = await knowledgeAgent(["/data/hr"], { allowedTools: ["pinchy_read"] });

    expect((await queueFirstIndex(reader.id, ADMIN, recorder().audit)).status).toBe("skipped");
    expect(await db.select().from(kbIndexJobs)).toEqual([]);
  });

  it("says the embedding model is missing to the admin who asked, and queues nothing", async () => {
    mockKbEmbedderAvailable.mockReturnValue(false);
    const agent = await knowledgeAgent(["/data/hr"]);
    const { entries, audit } = recorder();

    expect((await queueFirstIndex(agent.id, ADMIN, audit)).status).toBe("skipped");
    expect(await db.select().from(kbIndexJobs)).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      outcome: "failure",
      detail: { trigger: "initial", reason: "embedding_model_missing" },
    });
  });

  it("records nothing for the worker's own look while the model is missing", async () => {
    mockKbEmbedderAvailable.mockReturnValue(false);
    const agent = await knowledgeAgent(["/data/hr"]);
    const { entries, audit } = recorder();

    await queueFirstIndex(agent.id, { actorType: "system", actorId: "kb-index-worker" }, audit);

    expect(entries).toEqual([]);
  });
});

describe("agentsOwedFirstIndex", () => {
  it("names the searching agents with a folder nothing has indexed, oldest first", async () => {
    const first = await knowledgeAgent(["/data/hr"], { createdAt: new Date("2026-01-01") });
    const second = await knowledgeAgent(["/data/legal"], { createdAt: new Date("2026-02-01") });
    const done = await knowledgeAgent(["/data/sales"]);
    await finishedJob(done.id, ["/data/sales"], "succeeded");
    await knowledgeAgent(["/data/ops"], { allowedTools: ["pinchy_read"] });
    await knowledgeAgent(["/data/gone"], { deletedAt: new Date() });

    expect(await agentsOwedFirstIndex()).toEqual([first.id, second.id]);
  });
});

describe("getFirstIndexStatus", () => {
  it("says nothing for an agent whose folders are indexed", async () => {
    const agent = await knowledgeAgent(["/data/hr"]);
    await finishedJob(agent.id, ["/data/hr"], "succeeded");

    expect(await getFirstIndexStatus(agent)).toEqual({ state: "none" });
  });

  it("says nothing for an agent that does not search the index", async () => {
    const reader = await knowledgeAgent(["/data/hr"], { allowedTools: ["pinchy_read"] });

    expect(await getFirstIndexStatus(reader)).toEqual({ state: "none" });
  });

  it("reports the agent's own first run as it goes", async () => {
    const agent = await knowledgeAgent(["/data/hr"]);
    await queueFirstIndex(agent.id, ADMIN, recorder().audit);
    expect(await getFirstIndexStatus(agent)).toEqual({ state: "queued", partial: false });

    const job = await claimNextIndexJob();
    await recordIndexJobProgress(job!.id, {
      processed: 120,
      total: 505,
      processedBytes: 1,
      totalBytes: 2,
      counts: { indexed: 120, skipped: 0, removed: 0, unsearchable: 0, failed: 0, archived: 0 },
    });

    expect(await getFirstIndexStatus(agent)).toEqual({
      state: "indexing",
      processed: 120,
      total: 505,
      partial: false,
    });
  });

  it("reports an agent waiting behind another agent's run as waiting", async () => {
    const other = await knowledgeAgent(["/data/legal"]);
    await enqueueIndexJob({
      orgId: DEFAULT_ORG_ID,
      agentId: other.id,
      agentName: "Legal",
      requestedBy: "admin-1",
      paths: ["/data/legal"],
    });
    await claimNextIndexJob();
    const agent = await knowledgeAgent(["/data/hr"]);

    expect(await getFirstIndexStatus(agent)).toEqual({ state: "waiting", partial: false });
  });

  it("does not pass off the agent's own later run as its first index", async () => {
    // The agent's Reindex now over its old folder holds the slot while a
    // folder granted since waits: that run's count is not the new folder's.
    const agent = await knowledgeAgent(["/data/hr", "/data/legal"]);
    await finishedJob(agent.id, ["/data/hr"], "succeeded");
    await enqueueIndexJob({
      orgId: DEFAULT_ORG_ID,
      agentId: agent.id,
      agentName: "Handbook",
      requestedBy: "admin-1",
      paths: ["/data/hr"],
    });
    await claimNextIndexJob();

    expect(await getFirstIndexStatus(agent)).toEqual({ state: "waiting", partial: true });
  });

  it("says an agent with indexed folders is only waiting for the new one", async () => {
    // It answers from /data/hr throughout; the chat must not claim otherwise.
    const agent = await knowledgeAgent(["/data/hr", "/data/legal"]);
    await finishedJob(agent.id, ["/data/hr"], "succeeded");

    expect(await getFirstIndexStatus(agent)).toEqual({ state: "queued", partial: true });
  });

  it("reports another agent's run over the same folder as this agent's first index", async () => {
    // Agent B is created over a folder agent A's first index is reading: B
    // gets no run of its own, and its documents arrive with A's.
    const a = await knowledgeAgent(["/data/hr"]);
    await queueFirstIndex(a.id, ADMIN, recorder().audit);
    const job = await claimNextIndexJob();
    await recordIndexJobProgress(job!.id, {
      processed: 3,
      total: 9,
      processedBytes: 1,
      totalBytes: 2,
      counts: { indexed: 3, skipped: 0, removed: 0, unsearchable: 0, failed: 0, archived: 0 },
    });
    const b = await knowledgeAgent(["/data/hr/"]);

    expect((await queueFirstIndex(b.id, ADMIN, recorder().audit)).status).toBe("skipped");
    expect(await getFirstIndexStatus(b)).toEqual({
      state: "indexing",
      processed: 3,
      total: 9,
      partial: false,
    });
  });

  it("says nothing while the embedding model is missing, since no run can start", async () => {
    mockKbEmbedderAvailable.mockReturnValue(false);
    const agent = await knowledgeAgent(["/data/hr"]);

    expect(await getFirstIndexStatus(agent)).toEqual({ state: "none" });
  });
});
