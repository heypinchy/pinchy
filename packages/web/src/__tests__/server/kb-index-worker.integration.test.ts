/**
 * The knowledge-base index worker: claims a kb_index_jobs row, runs the ingest
 * against the job's snapshotted paths, and records what happened (#714).
 *
 * Against a real Postgres, because everything worth asserting here is a
 * transition of a real row — claimed, progressed, finished — plus the audit
 * entry that outlives the run. Ingest itself is dependency-injected (fake
 * embedder + extractor), so no Ollama and no real PDFs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { agents, auditLog, kbDocuments, kbIndexJobs } from "@/db/schema";
import { enqueueIndexJob, getLatestIndexJobForAgent } from "@/lib/knowledge/index-jobs";
import { runNextIndexJob } from "@/server/kb-index-worker";
import type { IngestDeps } from "@/lib/knowledge/ingest";

const ORG_ID = "org-kb-worker-test";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-kb-worker-test-"));
  await db.delete(kbIndexJobs);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function fakeDeps(): IngestDeps {
  return {
    embed: vi.fn(async (texts: string[]) => texts.map(() => Array(1024).fill(0.01))),
    extractPdf: vi.fn(async () => [
      { page: 1, text: "Onboarding starts on day one and every hire receives a laptop." },
    ]),
  };
}

async function makeAgent(name = "Smithers") {
  const [agent] = await db
    .insert(agents)
    .values({ name, model: "test-model", greetingMessage: "Hi" })
    .returning();
  return agent;
}

function writePdf(dir: string, name: string, bytes = "fake-pdf-bytes") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), bytes);
}

async function reindexAuditRows() {
  return db.select().from(auditLog).where(eq(auditLog.eventType, "knowledge.reindex"));
}

describe("kb index worker", () => {
  it("does nothing and reports nothing when the queue is empty", async () => {
    expect(await runNextIndexJob({ deps: fakeDeps() })).toBeNull();
    expect(await reindexAuditRows()).toHaveLength(0);
  });

  it("runs a queued job against its snapshotted paths and records the findings", async () => {
    const agent = await makeAgent();
    writePdf(tmpRoot, "handbook.pdf");
    await enqueueIndexJob({
      orgId: ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: "admin-1",
      paths: [tmpRoot],
    });

    const ran = await runNextIndexJob({ deps: fakeDeps() });

    expect(ran?.status).toBe("succeeded");
    const job = await getLatestIndexJobForAgent(agent.id);
    expect(job).toMatchObject({ status: "succeeded", processed: 1, total: 1 });
    expect(job?.counts).toEqual({
      indexed: 1,
      skipped: 0,
      removed: 0,
      unsearchable: 0,
      failed: 0,
    });
    expect(job?.finishedAt).toBeInstanceOf(Date);

    const docs = await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID));
    expect(docs).toHaveLength(1);
  });

  // The run lands hours after the request, in a context with no request behind
  // it, so it has to audit itself. Correlated to the admin's row by jobId — the
  // same reason GC sweeps carry a sweepId.
  it("audits the outcome as the system, correlated to the job", async () => {
    const agent = await makeAgent();
    writePdf(tmpRoot, "handbook.pdf");
    const { job } = await enqueueIndexJob({
      orgId: ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: "admin-1",
      paths: [tmpRoot],
    });

    await runNextIndexJob({ deps: fakeDeps() });

    const rows = await reindexAuditRows();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.actorType).toBe("system");
    expect(row.outcome).toBe("success");
    expect(row.resource).toBe(`agent:${agent.id}`);
    const detail = row.detail as Record<string, unknown>;
    expect(detail.jobId).toBe(job.id);
    expect(detail.agent).toEqual({ id: agent.id, name: "Smithers" });
    expect(detail).toMatchObject({ indexed: 1, unsearchable: 0, failed: 0, pathCount: 1 });

    // The granted folder is a real filesystem path and can embed a username.
    expect(JSON.stringify(row.detail)).not.toContain(tmpRoot);
  });

  // A renamed or deleted agent must not cost us the name on the audit row: the
  // job snapshotted it at enqueue precisely so the outcome row can still say
  // who it was for.
  it("audits under the agent name as it was when the reindex was requested", async () => {
    const agent = await makeAgent("Old Name");
    writePdf(tmpRoot, "handbook.pdf");
    await enqueueIndexJob({
      orgId: ORG_ID,
      agentId: agent.id,
      agentName: "Old Name",
      requestedBy: "admin-1",
      paths: [tmpRoot],
    });
    await db.update(agents).set({ name: "New Name" }).where(eq(agents.id, agent.id));

    await runNextIndexJob({ deps: fakeDeps() });

    const [row] = await reindexAuditRows();
    expect((row.detail as { agent: unknown }).agent).toEqual({ id: agent.id, name: "Old Name" });
  });

  it("publishes progress as it goes, not only at the end", async () => {
    const agent = await makeAgent();
    writePdf(tmpRoot, "a.pdf", "a");
    writePdf(tmpRoot, "b.pdf", "b");
    await enqueueIndexJob({
      orgId: ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: "admin-1",
      paths: [tmpRoot],
    });

    // Observed mid-run: a progress column only written at the end is a
    // completion flag with extra steps, and the whole point of the job is that
    // an admin can watch a multi-hour run advance.
    const seen: Array<{ processed: number; total: number | null }> = [];
    const deps = fakeDeps();
    const realExtract = deps.extractPdf;
    deps.extractPdf = async (p: string) => {
      const [row] = await db.select().from(kbIndexJobs).limit(1);
      seen.push({ processed: row.processed, total: row.total });
      return realExtract(p);
    };

    await runNextIndexJob({ deps });

    expect(seen).toEqual([
      { processed: 0, total: 2 },
      { processed: 1, total: 2 },
    ]);
    expect(await getLatestIndexJobForAgent(agent.id)).toMatchObject({ processed: 2, total: 2 });
  });

  // A corrupt file is the job's finding, not the job's failure: the run did
  // what it was asked to and the rest of the corpus is indexed.
  it("succeeds with a failed-file count when only individual files are broken", async () => {
    const agent = await makeAgent();
    writePdf(tmpRoot, "a-broken.pdf", "broken");
    writePdf(tmpRoot, "b-good.pdf", "good");
    await enqueueIndexJob({
      orgId: ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: "admin-1",
      paths: [tmpRoot],
    });

    const deps = fakeDeps();
    deps.extractPdf = async (p: string) => {
      if (p.endsWith("a-broken.pdf")) throw new Error("Invalid PDF structure");
      return [{ page: 1, text: "Onboarding starts on day one for every new hire." }];
    };

    await runNextIndexJob({ deps });

    const job = await getLatestIndexJobForAgent(agent.id);
    expect(job?.status).toBe("succeeded");
    expect(job?.counts).toMatchObject({ indexed: 1, failed: 1 });
    const [row] = await reindexAuditRows();
    expect(row.outcome).toBe("success");
  });

  // A systemic outage is the job's failure. It must land as one, keep the
  // partial counts, and — critically — release the org's active-job slot, or
  // one Ollama blip would wedge the queue until a restart.
  it("fails the job on a systemic outage, keeps partial counts, and frees the slot", async () => {
    const agent = await makeAgent();
    writePdf(tmpRoot, "a.pdf", "a");
    await enqueueIndexJob({
      orgId: ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: "admin-1",
      paths: [tmpRoot],
    });

    const deps = fakeDeps();
    deps.embed = async () => {
      throw new Error("connect ECONNREFUSED ollama.local:11434");
    };

    const ran = await runNextIndexJob({ deps });

    expect(ran?.status).toBe("failed");
    const job = await getLatestIndexJobForAgent(agent.id);
    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("ECONNREFUSED");
    expect(job?.counts).toEqual({
      indexed: 0,
      skipped: 0,
      removed: 0,
      unsearchable: 0,
      failed: 0,
    });

    const [row] = await reindexAuditRows();
    expect(row.outcome).toBe("failure");
    expect((row.detail as { reason?: string }).reason).toBeTruthy();

    // The slot is free: the next enqueue is accepted rather than told "busy".
    const next = await enqueueIndexJob({
      orgId: ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: "admin-1",
      paths: [tmpRoot],
    });
    expect(next.status).toBe("queued");
  });

  // A granted folder can be empty, or gone by the time the job runs. That is a
  // finished job reporting 0/0, not a stuck one.
  it("finishes a job whose folders hold nothing to index", async () => {
    const agent = await makeAgent();
    await enqueueIndexJob({
      orgId: ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: "admin-1",
      paths: [join(tmpRoot, "empty")],
    });

    await runNextIndexJob({ deps: fakeDeps() });

    const job = await getLatestIndexJobForAgent(agent.id);
    expect(job).toMatchObject({ status: "succeeded", processed: 0, total: 0 });
  });

  // The route's 503 only covers the moment of the request. Between enqueue and
  // run — hours, on a real corpus — the Ollama setting can be cleared, so the
  // worker resolves it itself and fails the job honestly instead of throwing an
  // opaque error into the interval.
  it("fails the job when the embedding endpoint is not configured at run time", async () => {
    const agent = await makeAgent();
    writePdf(tmpRoot, "handbook.pdf");
    await enqueueIndexJob({
      orgId: ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: "admin-1",
      paths: [tmpRoot],
    });

    // No deps injected and no Ollama setting seeded: the production resolution
    // path runs and finds nothing.
    const ran = await runNextIndexJob();

    expect(ran?.status).toBe("failed");
    const job = await getLatestIndexJobForAgent(agent.id);
    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("ollama_not_configured");

    const [row] = await reindexAuditRows();
    expect(row.outcome).toBe("failure");
    expect((row.detail as { reason?: string }).reason).toContain("ollama_not_configured");
  });
});
