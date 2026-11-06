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
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { makeKbSourceRoot } from "@/test-helpers/kb-source-root";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { agents, auditLog, kbChunks, kbDocuments, kbIndexJobs } from "@/db/schema";
import { DEFAULT_ORG_ID } from "@/lib/knowledge/constants";
import { enqueueIndexJob, getLatestIndexJobForAgent } from "@/lib/knowledge/index-jobs";
import {
  runNextIndexJob,
  runKbIndexWorkerTick,
  _resetKbIndexWorkerForTest,
} from "@/server/kb-index-worker";
import { ingestPaths, type IngestDeps } from "@/lib/knowledge/ingest";
import { OFFICE_ARTIFACT_FORMAT_VERSION } from "@/lib/knowledge/office-artifacts";
import { queueReconversion } from "@/lib/knowledge/office-format-upgrade";

const mockKbEmbedderAvailable = vi.fn(() => true);
vi.mock("@/lib/knowledge/kb-embedder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/knowledge/kb-embedder")>()),
  kbEmbedderAvailable: () => mockKbEmbedderAvailable(),
}));

const ORG_ID = "org-kb-worker-test";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = makeKbSourceRoot("pinchy-kb-worker-test-");
  await db.delete(kbIndexJobs);
  _resetKbIndexWorkerForTest();
  mockKbEmbedderAvailable.mockReturnValue(true);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function fakeDeps(): IngestDeps {
  return {
    embed: vi.fn(async (texts: string[]) => texts.map(() => Array(768).fill(0.01))),
    extractPdf: vi.fn(async () => [
      { page: 1, text: "Onboarding starts on day one and every hire receives a laptop." },
    ]),
    // This suite indexes PDFs only; a spreadsheet or an Office document
    // reaching it would mean the dispatch is broken, so the stubs throw rather
    // than returning nothing.
    extractXlsx: vi.fn(async () => {
      throw new Error("extractXlsx must not be called for a PDF");
    }),
    convertOffice: vi.fn(async () => {
      throw new Error("convertOffice must not be called for a PDF");
    }),
    ocrModel: null,
    // Hidden, so a run over tmpRoot never lists its own copies.
    stagingDir: join(tmpRoot, ".kb-artifacts", "staging"),
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
      archived: 0,
      unsupported: 0,
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

  // The outcome row is written hours after the request by a worker that does
  // not care who asked. It still has to say: a reader filtering the trail for
  // last night's automatic runs finds the outcome rows, not only the requests.
  it("carries the job's trigger onto the outcome row", async () => {
    const agent = await makeAgent();
    writePdf(tmpRoot, "handbook.pdf");
    await enqueueIndexJob({
      orgId: ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: "admin-1",
      paths: [tmpRoot],
    });

    await runNextIndexJob({ deps: fakeDeps() });

    const [row] = await reindexAuditRows();
    expect(row.detail).toMatchObject({ trigger: "manual" });
    expect(row.detail).not.toHaveProperty("sweepId");
  });

  it("carries a scheduled job's trigger and sweep onto the outcome row", async () => {
    const agent = await makeAgent();
    writePdf(tmpRoot, "handbook.pdf");
    const sweepId = "0d6c1a3e-6a1f-4c55-9b55-2f4b6f0a9e11";
    await enqueueIndexJob({
      orgId: ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: "kb-index-scheduler",
      paths: [tmpRoot],
      trigger: "scheduled",
      sweepId,
    });

    await runNextIndexJob({ deps: fakeDeps() });

    const [row] = await reindexAuditRows();
    expect(row.actorType).toBe("system");
    expect(row.detail).toMatchObject({ trigger: "scheduled", sweepId });
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

  // The seam the ETA hangs from (#907), and the one nothing else covers: ingest
  // emits the byte counters, index-jobs writes them, the route projects them —
  // each tested on its own. This asserts the WORKER carries them between the
  // first two. A `{ processed, total, counts }` destructuring here would leave
  // total_bytes null and processed_bytes at 0 forever: no error, no red test,
  // just an estimate that never appears again and a bar quietly back on the
  // document count it was built to replace.
  //
  // Sizes are deliberately unequal — two 1-byte files would let a doc-count
  // projection pass this by coincidence.
  it("carries the byte counters onto the job row, not just the document counts", async () => {
    const agent = await makeAgent();
    writePdf(tmpRoot, "small.pdf", "s".repeat(300));
    writePdf(tmpRoot, "large.pdf", "l".repeat(700));
    await enqueueIndexJob({
      orgId: ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: "admin-1",
      paths: [tmpRoot],
    });

    const seen: Array<{ processedBytes: number; totalBytes: number | null }> = [];
    const deps = fakeDeps();
    const realExtract = deps.extractPdf;
    deps.extractPdf = async (p: string) => {
      const [row] = await db.select().from(kbIndexJobs).limit(1);
      seen.push({ processedBytes: row.processedBytes, totalBytes: row.totalBytes });
      return realExtract(p);
    };

    await runNextIndexJob({ deps });

    // The total is known in full from the first reading — that is what makes it
    // a denominator rather than a guess — and the run climbs to it.
    expect(seen[0]).toEqual({ processedBytes: 0, totalBytes: 1000 });
    // readdir order is the filesystem's business, not ours, so this names the
    // sizes rather than the sequence: whichever file the walk reached first,
    // the credit after it is exactly THAT file's size on disk. A run that
    // credited an even share per document would read 500 and fail here.
    expect(seen[1].totalBytes).toBe(1000);
    expect([300, 700]).toContain(seen[1].processedBytes);
    expect(await getLatestIndexJobForAgent(agent.id)).toMatchObject({
      processedBytes: 1000,
      totalBytes: 1000,
    });
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

  // A systemic outage is the job's failure. It must land as one and —
  // critically — release the org's active-job slot, or one Ollama blip would
  // wedge the queue until a restart.
  it("fails the job on a systemic outage and frees the slot", async () => {
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

  // A granted folder can be empty. That is a finished job reporting 0/0, not a
  // stuck one.
  it("finishes a job whose folders hold nothing to index", async () => {
    const agent = await makeAgent();
    const empty = join(tmpRoot, "empty");
    mkdirSync(empty, { recursive: true });
    await enqueueIndexJob({
      orgId: ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: "admin-1",
      paths: [empty],
    });

    await runNextIndexJob({ deps: fakeDeps() });

    const job = await getLatestIndexJobForAgent(agent.id);
    expect(job).toMatchObject({ status: "succeeded", processed: 0, total: 0 });
  });

  // A folder that is GONE is a different answer. Reporting it as "succeeded,
  // 0 indexed" is what an unmounted share looks like, every night, in a UI
  // that says "Last indexed automatically today". Still finished, not stuck —
  // but failed, and saying why.
  it("fails a job when none of its folders could be read, and says what to check", async () => {
    const agent = await makeAgent();
    await enqueueIndexJob({
      orgId: ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: "admin-1",
      paths: [join(tmpRoot, "not-mounted")],
    });

    await runNextIndexJob({ deps: fakeDeps() });

    const job = await getLatestIndexJobForAgent(agent.id);
    expect(job?.status).toBe("failed");
    expect(job?.error).toMatch(/None of the granted folders could be read/);
    const [row] = await reindexAuditRows();
    expect(row.outcome).toBe("failure");
    expect((row.detail as { reason?: string }).reason).toMatch(
      /None of the granted folders could be read/
    );
    // A folder path can embed a username; the server log names it, the row does not.
    expect(JSON.stringify(row.detail)).not.toContain(tmpRoot);
  });

  // One folder of several missing is worth knowing about without failing the
  // run that indexed the others. Counted on the outcome row, never named.
  it("counts the folders it could not read on the outcome row", async () => {
    const agent = await makeAgent();
    writePdf(join(tmpRoot, "present"), "handbook.pdf");
    await enqueueIndexJob({
      orgId: ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: "admin-1",
      paths: [join(tmpRoot, "present"), join(tmpRoot, "not-mounted")],
    });

    await runNextIndexJob({ deps: fakeDeps() });

    const job = await getLatestIndexJobForAgent(agent.id);
    expect(job?.status).toBe("succeeded");
    const [row] = await reindexAuditRows();
    expect(row.detail).toMatchObject({ indexed: 1, unavailableFolders: 1 });
  });

  // A file swapped for a link after the folder was listed is refused, not read
  // (lib/knowledge/verified-source.ts). That is a security-relevant event, so
  // the outcome row counts it apart from ordinary unreadable files — and, like
  // every other count here, never names the file.
  it("counts files refused as swapped links on the outcome row, without naming them", async () => {
    const agent = await makeAgent();
    writePdf(tmpRoot, "a.pdf", "first");
    writePdf(tmpRoot, "b.pdf", "second");
    const otherTeam = `${tmpRoot}-other-team`;
    writePdf(otherTeam, "board.pdf", "TOP SECRET");
    await enqueueIndexJob({
      orgId: ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: "admin-1",
      paths: [tmpRoot],
    });

    // Whichever file is read first swaps the OTHER one for a link, between
    // discovery and its read — the window an author of the share would use.
    const deps = fakeDeps();
    let swapped = false;
    const seen: string[] = [];
    deps.extractPdf = vi.fn(async (path: string) => {
      seen.push(readFileSync(path, "utf8"));
      if (!swapped) {
        swapped = true;
        const other = join(tmpRoot, basename(path) === "a.pdf" ? "b.pdf" : "a.pdf");
        rmSync(other);
        symlinkSync(join(otherTeam, "board.pdf"), other);
      }
      return [{ page: 1, text: "Onboarding starts on day one and every hire receives a laptop." }];
    });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runNextIndexJob({ deps });
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
      rmSync(otherTeam, { recursive: true, force: true });
    }

    expect(seen).not.toContain("TOP SECRET");
    const job = await getLatestIndexJobForAgent(agent.id);
    expect(job).toMatchObject({ status: "succeeded" });
    expect(job?.counts).toMatchObject({ indexed: 1, failed: 1 });
    const [row] = await reindexAuditRows();
    expect(row.detail).toMatchObject({ indexed: 1, failed: 1, refusedFiles: 1 });
    expect(JSON.stringify(row.detail)).not.toContain(tmpRoot);
  });

  it("leaves refusedFiles off the outcome row when nothing was refused", async () => {
    const agent = await makeAgent();
    writePdf(tmpRoot, "handbook.pdf");
    await enqueueIndexJob({
      orgId: ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: "admin-1",
      paths: [tmpRoot],
    });

    await runNextIndexJob({ deps: fakeDeps() });

    const [row] = await reindexAuditRows();
    expect(row.detail).not.toHaveProperty("refusedFiles");
  });

  // The audit row is not where an admin looks. A run that indexed one share and
  // could not read the other is a success with a hole in it, and the Index
  // section has to be able to say so — from the job, not the trail.
  it("records on the job how many folders it had to leave out", async () => {
    const agent = await makeAgent();
    writePdf(join(tmpRoot, "present"), "handbook.pdf");
    await enqueueIndexJob({
      orgId: ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: "admin-1",
      paths: [join(tmpRoot, "present"), join(tmpRoot, "not-mounted")],
    });

    await runNextIndexJob({ deps: fakeDeps() });

    const job = await getLatestIndexJobForAgent(agent.id);
    expect(job).toMatchObject({ status: "succeeded", unavailableFolders: 1 });
  });

  // A share mounted BELOW a granted folder fails as an empty folder inside a
  // root that still has files. The run succeeds on the rest, keeps that
  // folder's documents, and counts it like a root it could not read.
  it("keeps an emptied folder below a granted folder and counts it", async () => {
    const agent = await makeAgent();
    writePdf(tmpRoot, "readme.pdf");
    writePdf(join(tmpRoot, "contracts"), "contract.pdf");
    await enqueueIndexJob({
      orgId: ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: "admin-1",
      paths: [tmpRoot],
    });
    await runNextIndexJob({ deps: fakeDeps() });
    rmSync(join(tmpRoot, "contracts", "contract.pdf"));
    await enqueueIndexJob({
      orgId: ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: "admin-1",
      paths: [tmpRoot],
    });

    const ran = await runNextIndexJob({ deps: fakeDeps() });

    expect(ran).toMatchObject({ status: "succeeded", unavailableFolders: 1 });
    expect(ran?.counts).toMatchObject({ removed: 0 });
    expect(await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID))).toHaveLength(
      2
    );
  });

  describe("a folder that comes up empty while the index still holds its documents", () => {
    async function indexThenEmpty(agentId: string, agentName: string) {
      const share = join(tmpRoot, "share");
      writePdf(share, "handbook.pdf");
      await enqueueIndexJob({
        orgId: ORG_ID,
        agentId,
        agentName,
        requestedBy: "admin-1",
        paths: [share],
      });
      await runNextIndexJob({ deps: fakeDeps() });
      rmSync(join(share, "handbook.pdf"));
      return share;
    }

    // Nobody is watching at 02:00, and a share that failed to mount looks
    // exactly like this from inside the container. Wiping the folder's index
    // would cost a full re-embed; leaving it costs one stale night.
    it("is left alone by the nightly run, which fails and says why", async () => {
      const agent = await makeAgent();
      const share = await indexThenEmpty(agent.id, agent.name);
      await enqueueIndexJob({
        orgId: ORG_ID,
        agentId: agent.id,
        agentName: agent.name,
        requestedBy: "kb-index-scheduler",
        paths: [share],
        trigger: "scheduled",
        sweepId: "0d6c1a3e-6a1f-4c55-9b55-2f4b6f0a9e11",
      });

      const ran = await runNextIndexJob({ deps: fakeDeps() });

      expect(ran?.status).toBe("failed");
      expect(ran?.error).toMatch(/None of the granted folders could be read/);
      expect(await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID))).toHaveLength(
        1
      );
    });

    // The admin's own run gets the same protection. The run that failed above
    // says "check that it is mounted" — and the obvious next move is to click
    // Reindex now to retry. With the share still down, a literal reading of
    // the empty mountpoint would delete the whole folder's index right then.
    it("is left alone by a run an admin started, too", async () => {
      const agent = await makeAgent();
      const share = await indexThenEmpty(agent.id, agent.name);
      await enqueueIndexJob({
        orgId: ORG_ID,
        agentId: agent.id,
        agentName: agent.name,
        requestedBy: "admin-1",
        paths: [share],
      });

      const ran = await runNextIndexJob({ deps: fakeDeps() });

      expect(ran?.status).toBe("failed");
      expect(ran?.error).toMatch(/None of the granted folders could be read/);
      expect(await db.select().from(kbDocuments).where(eq(kbDocuments.orgId, ORG_ID))).toHaveLength(
        1
      );
    });
  });

  // The whole reason a failed run keeps counts: a 2000-PDF run that dies at
  // file 1501 indexed 1500 documents, and "indexed: 0" would be a false report
  // of an empty corpus on an HMAC-signed audit row. The counts have to come
  // from what the run actually did before it died, not from the initial value
  // of a variable the throw skipped past.
  it("records what a failed run had already indexed, not zeros", async () => {
    const agent = await makeAgent();
    writePdf(tmpRoot, "a-good.pdf", "a");
    writePdf(tmpRoot, "b-good.pdf", "b");
    writePdf(tmpRoot, "c-outage.pdf", "c");
    await enqueueIndexJob({
      orgId: ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: "admin-1",
      paths: [tmpRoot],
    });

    // Two files embed fine; the endpoint dies on the third.
    const deps = fakeDeps();
    let embedCalls = 0;
    deps.embed = async (texts: string[]) => {
      if (++embedCalls > 2) throw new Error("connect ECONNREFUSED ollama.local:11434");
      return texts.map(() => Array(768).fill(0.01));
    };

    await runNextIndexJob({ deps });

    const job = await getLatestIndexJobForAgent(agent.id);
    expect(job?.status).toBe("failed");
    expect(job?.counts).toMatchObject({ indexed: 2 });
    expect(job?.processed).toBe(2);

    // And the audit row carries the same truth — it is the record that outlives
    // the job row.
    const [row] = await reindexAuditRows();
    expect(row.outcome).toBe("failure");
    expect(row.detail).toMatchObject({ indexed: 2 });
  });

  // The route's 503 precheck only covers the moment of the request. Between
  // enqueue and run — hours, on a real corpus — the bundled model file could
  // vanish (a broken remount), so the worker re-resolves the embedder itself
  // and fails the job honestly instead of throwing an opaque error into the
  // interval. KB_EMBEDDING_MODEL_PATH points at a nonexistent path in the
  // integration config, so the production resolution path finds no model.
  it("fails the job when the bundled embedding model is missing at run time", async () => {
    const agent = await makeAgent();
    writePdf(tmpRoot, "handbook.pdf");
    await enqueueIndexJob({
      orgId: ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: "admin-1",
      paths: [tmpRoot],
    });

    // No deps injected: the production resolution path runs and finds no GGUF.
    mockKbEmbedderAvailable.mockReturnValue(false);
    const ran = await runNextIndexJob();

    expect(ran?.status).toBe("failed");
    const job = await getLatestIndexJobForAgent(agent.id);
    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("embedding_model_missing");

    const [row] = await reindexAuditRows();
    expect(row.outcome).toBe("failure");
    expect((row.detail as { reason?: string }).reason).toContain("embedding_model_missing");
  });
});

describe("kb index worker tick", () => {
  it("requeues jobs orphaned by a crash before it claims anything", async () => {
    const agent = await makeAgent();
    writePdf(tmpRoot, "handbook.pdf");
    await enqueueIndexJob({
      orgId: ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: "admin-1",
      paths: [tmpRoot],
    });
    // A job left `running` by the process that died — nothing else can be
    // holding it, so this tick has to free it and then run it.
    await db.update(kbIndexJobs).set({ status: "running", startedAt: new Date() });

    await runKbIndexWorkerTick({ deps: fakeDeps() });

    expect(await getLatestIndexJobForAgent(agent.id)).toMatchObject({ status: "succeeded" });
  });

  it("clears the staged copies an interrupted run left behind, before it claims anything", async () => {
    // A batch removes its staging directory when it finishes, and a read
    // removes its private copy of the document; one that never finishes — a
    // restart, an upgrade, an OOM kill mid-reindex — leaves them on the
    // artifact volume, plaintext, and nothing else ever removes them. Same
    // boot act as the requeue, for the same reason it is sound: this process
    // is the only worker and has not started a batch or a read yet, so
    // whatever wrote them is gone.
    const artifactDir = join(tmpRoot, ".kb-artifacts");
    const leftover = join(artifactDir, "staging", "batch-of-a-dead-process", "in", "0.pptx");
    const leftoverCopy = join(artifactDir, "staging", "source-of-a-dead-read", "board.pdf");
    const artifact = join(artifactDir, "v2", "ab", "kept.pdf");
    for (const path of [leftover, leftoverCopy, artifact]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "bytes");
    }
    const corpus = join(tmpRoot, "corpus");
    writePdf(corpus, "handbook.pdf");
    const agent = await makeAgent();
    await enqueueIndexJob({
      orgId: ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: "admin-1",
      paths: [corpus],
    });
    const deps = fakeDeps();
    const leftoverWhenClaimed: boolean[] = [];
    const extractPdf = deps.extractPdf;
    deps.extractPdf = async (...args) => {
      leftoverWhenClaimed.push(existsSync(leftover) || existsSync(leftoverCopy));
      return extractPdf(...args);
    };

    await runKbIndexWorkerTick({ deps, artifactDir });

    expect(leftoverWhenClaimed).toEqual([false]);
    expect(readdirSync(join(artifactDir, "staging"))).toEqual([]);
    expect(existsSync(artifact)).toBe(true);
    expect(await getLatestIndexJobForAgent(agent.id)).toMatchObject({ status: "succeeded" });
  });

  it("removes the artifacts of superseded format versions, before it claims anything", async () => {
    // After a format bump the preview resolves only the current version, so
    // the old directory is unreachable — but it still holds what the earlier,
    // weaker conversion drew into its PDFs, and it costs disk.
    const artifactDir = join(tmpRoot, "artifacts");
    const superseded = join(artifactDir, `v${OFFICE_ARTIFACT_FORMAT_VERSION - 1}`, "ab", "old.pdf");
    const current = join(artifactDir, `v${OFFICE_ARTIFACT_FORMAT_VERSION}`, "ab", "kept.pdf");
    for (const path of [superseded, current]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "bytes");
    }
    const corpus = join(tmpRoot, "corpus");
    writePdf(corpus, "handbook.pdf");
    const agent = await makeAgent();
    await enqueueIndexJob({
      orgId: ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: "admin-1",
      paths: [corpus],
    });
    const deps = fakeDeps();
    const supersededWhenClaimed: boolean[] = [];
    const extractPdf = deps.extractPdf;
    deps.extractPdf = async (...args) => {
      supersededWhenClaimed.push(existsSync(superseded));
      return extractPdf(...args);
    };

    await runKbIndexWorkerTick({ deps, artifactDir });

    expect(supersededWhenClaimed).toEqual([false]);
    expect(readdirSync(artifactDir).sort()).toEqual([`v${OFFICE_ARTIFACT_FORMAT_VERSION}`]);
    expect(existsSync(current)).toBe(true);
    expect(await getLatestIndexJobForAgent(agent.id)).toMatchObject({ status: "succeeded" });
  });

  describe("Office documents an earlier artifact format indexed", () => {
    // AGENTS.md § "Test Migrations Against Pre-Existing Data". After a bump
    // of OFFICE_ARTIFACT_FORMAT_VERSION, the rows the upgrade finds were read
    // from PDFs the earlier conversion made. The ingest converts them again
    // on its next run — but the nightly run can be switched off, and until
    // then their previews cannot open and their chunks answer no search. So
    // the worker queues that run itself, at boot and hourly after.
    const LEAKED = "root:x:0:0:root:/root:/bin/bash daemon:x:1:1:daemon";
    const CLEAN = "Every delivery is checked against the order before it goes into storage.";

    /** Ingest deps whose converter "converts" every Office file to a PDF reading `text`. */
    function officeDeps(text: string, status: "converted" | "infrastructure" = "converted") {
      const deps = fakeDeps();
      deps.extractPdf = vi.fn(async () => [{ page: 1, text }]);
      deps.convertOffice = vi.fn(async (sources: readonly { absPath: string }[]) =>
        sources.map((source) =>
          status === "converted"
            ? { sourcePath: source.absPath, status, artifactPath: join(tmpRoot, "artifact.pdf") }
            : { sourcePath: source.absPath, status, reason: "converter was killed" }
        )
      );
      return deps;
    }

    async function knowledgeAgent(corpus: string | readonly string[], name = "Archivist") {
      const [agent] = await db
        .insert(agents)
        .values({
          name,
          model: "test-model",
          greetingMessage: "Hi",
          allowedTools: ["knowledge_search"],
          pluginConfig: {
            "pinchy-files": { allowed_paths: typeof corpus === "string" ? [corpus] : [...corpus] },
          },
        })
        .returning();
      return agent;
    }

    /**
     * A Word document in `corpus`, indexed the way the upgrade finds it: its
     * chunks read from an earlier format's artifact, which sits in `v1/`, and
     * the row written before its version was recorded.
     */
    async function indexedBeforeTheBump(corpus: string, artifactDir: string) {
      mkdirSync(corpus, { recursive: true });
      writeFileSync(join(corpus, "Angebot.docx"), "docx-bytes");
      await ingestPaths(DEFAULT_ORG_ID, [corpus], officeDeps(LEAKED));
      await db.update(kbDocuments).set({ artifactFormatVersion: null });
      const earlierArtifact = join(artifactDir, "v1", "ab", "earlier.pdf");
      mkdirSync(dirname(earlierArtifact), { recursive: true });
      writeFileSync(earlierArtifact, LEAKED);
      return earlierArtifact;
    }

    async function documentText(): Promise<string> {
      const [doc] = await db.select().from(kbDocuments);
      const chunks = await db.select().from(kbChunks).where(eq(kbChunks.documentId, doc.id));
      return chunks.map((chunk) => chunk.chunkText).join("\n");
    }

    it("converts them again at boot, under the current rules, without waiting for a nightly run", async () => {
      const artifactDir = join(tmpRoot, "artifacts");
      const corpus = join(tmpRoot, "corpus");
      const earlierArtifact = await indexedBeforeTheBump(corpus, artifactDir);
      const agent = await knowledgeAgent(corpus);
      expect(await documentText()).toContain(LEAKED);

      const deps = officeDeps(CLEAN);
      // The earlier format's directory is kept while a row still names it —
      // a rollback to that version would find its previews there.
      const earlierKeptWhileConverting: boolean[] = [];
      const convertOffice = deps.convertOffice;
      deps.convertOffice = async (sources) => {
        earlierKeptWhileConverting.push(existsSync(earlierArtifact));
        return convertOffice(sources);
      };

      await runKbIndexWorkerTick({ deps, artifactDir });

      const job = await getLatestIndexJobForAgent(agent.id);
      expect(job).toMatchObject({
        status: "succeeded",
        trigger: "upgrade",
        requestedBy: "kb-index-worker",
        paths: [corpus],
        counts: expect.objectContaining({ indexed: 1 }),
      });
      const [doc] = await db.select().from(kbDocuments);
      expect(doc.artifactFormatVersion).toBe(OFFICE_ARTIFACT_FORMAT_VERSION);
      const text = await documentText();
      expect(text).toContain(CLEAN);
      expect(text).not.toContain(LEAKED);

      // Kept while the row named it, gone once nothing does.
      expect(earlierKeptWhileConverting).toEqual([true]);
      expect(existsSync(join(artifactDir, "v1"))).toBe(false);

      // Requested and finished on the record, both as Pinchy's own decision.
      const rows = await reindexAuditRows();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.actorId).toBe("kb-index-worker");
        expect(row.outcome).toBe("success");
        expect(row.detail).toMatchObject({
          trigger: "upgrade",
          jobId: job!.id,
          agent: { id: agent.id, name: agent.name },
        });
      }
    });

    it("queues nothing when every Office document is already current", async () => {
      const corpus = join(tmpRoot, "corpus");
      mkdirSync(corpus, { recursive: true });
      writeFileSync(join(corpus, "Angebot.docx"), "docx-bytes");
      await ingestPaths(DEFAULT_ORG_ID, [corpus], officeDeps(CLEAN));
      await knowledgeAgent(corpus);

      await runKbIndexWorkerTick({ deps: officeDeps(CLEAN), artifactDir: join(tmpRoot, "a") });

      expect(await db.select().from(kbIndexJobs)).toEqual([]);
      expect(await reindexAuditRows()).toEqual([]);
    });

    it("queues nothing for an agent whose other folders hold only current documents", async () => {
      // The superseded rows are looked for under ALL of an agent's folders at
      // once — and only rows that are both superseded and under one of them
      // count, however many folders it has.
      const offices = join(tmpRoot, "offices");
      mkdirSync(offices, { recursive: true });
      writeFileSync(join(offices, "Angebot.docx"), "docx-bytes");
      await ingestPaths(DEFAULT_ORG_ID, [offices], officeDeps(CLEAN));
      const handbooks = join(tmpRoot, "handbooks");
      writePdf(handbooks, "handbook.pdf");
      await ingestPaths(DEFAULT_ORG_ID, [handbooks], fakeDeps());
      await knowledgeAgent([offices, handbooks]);

      await runKbIndexWorkerTick({ deps: officeDeps(CLEAN), artifactDir: join(tmpRoot, "a") });

      expect(await db.select().from(kbIndexJobs)).toEqual([]);
      expect(await reindexAuditRows()).toEqual([]);
    });

    it("converts a folder several agents share once, even when a document in it cannot be converted now", async () => {
      // A conversion that ends `infrastructure` (out of memory, a timeout,
      // LibreOffice down) leaves its row superseded. Every other agent granted
      // the same folder would still find it owed, and run the same folder
      // again for nothing.
      const artifactDir = join(tmpRoot, "artifacts");
      const shared = join(tmpRoot, "shared");
      const contracts = join(shared, "contracts");
      const own = join(tmpRoot, "own");
      await indexedBeforeTheBump(contracts, artifactDir);
      await indexedBeforeTheBump(own, artifactDir);
      const first = await knowledgeAgent(shared, "Archivist");
      await knowledgeAgent(shared, "Clerk");
      // A folder inside the one already run holds nothing it did not cover.
      await knowledgeAgent(contracts, "Intern");
      // A folder of its own still gets its run.
      const elsewhere = await knowledgeAgent(own, "Auditor");
      const squeezed = officeDeps(CLEAN, "infrastructure");

      await runKbIndexWorkerTick({ deps: squeezed, artifactDir });

      const jobs = await db.select().from(kbIndexJobs).orderBy(kbIndexJobs.createdAt);
      expect(jobs.map((job) => [job.agentId, job.paths])).toEqual([
        [first.id, [shared]],
        [elsewhere.id, [own]],
      ]);
      expect(squeezed.convertOffice).toHaveBeenCalledTimes(2);
    });

    it("converts them for the agents that search, never through an agent that only reads files", async () => {
      // An agent without knowledge_search never looks at the index, so the
      // nightly run skips it. Running its folders here would embed — and send
      // to the vision model — everything it can read, for nobody.
      const artifactDir = join(tmpRoot, "artifacts");
      const data = join(tmpRoot, "data");
      const projects = join(data, "Projekte");
      await indexedBeforeTheBump(projects, artifactDir);
      writePdf(data, "handbook.pdf");
      const [reader] = await db
        .insert(agents)
        .values({
          name: "Reader",
          model: "test-model",
          greetingMessage: "Hi",
          allowedTools: ["pinchy_read"],
          pluginConfig: { "pinchy-files": { allowed_paths: [data] } },
        })
        .returning();
      const searcher = await knowledgeAgent(projects);
      const deps = officeDeps(CLEAN);

      await runKbIndexWorkerTick({ deps, artifactDir });

      const jobs = await db.select().from(kbIndexJobs);
      expect(jobs.map((job) => [job.agentId, job.paths])).toEqual([[searcher.id, [projects]]]);
      expect(deps.extractPdf).toHaveBeenCalledTimes(1);
      expect(await queueReconversion(reader.id)).toEqual({ status: "skipped" });
    });

    it("lets the earlier format's directory go once no searching agent's folder holds a document read from it", async () => {
      // Nothing would ever convert those documents again — no run reaches a
      // folder no searching agent is granted — and no search reaches them
      // either. They stay on record, still hidden; a searching agent granted
      // the folder later converts them on its first run.
      const artifactDir = join(tmpRoot, "artifacts");
      const corpus = join(tmpRoot, "corpus");
      await indexedBeforeTheBump(corpus, artifactDir);
      await db.insert(agents).values({
        name: "Reader",
        model: "test-model",
        greetingMessage: "Hi",
        allowedTools: ["pinchy_read"],
        pluginConfig: { "pinchy-files": { allowed_paths: [corpus] } },
      });

      await runKbIndexWorkerTick({ deps: officeDeps(CLEAN), artifactDir });

      expect(await db.select().from(kbIndexJobs)).toEqual([]);
      expect(existsSync(join(artifactDir, "v1"))).toBe(false);
      const [doc] = await db.select().from(kbDocuments);
      expect(doc.artifactFormatVersion).toBeNull();
    });

    describe("after boot", () => {
      // The worker never reads the nightly schedule: only its own ticks run
      // here, exactly as on an instance with the schedule switched off. So
      // whatever converts these documents without a restart is the worker's
      // own look for them, not a nightly run.
      const BOOT = new Date("2026-11-03T09:00:00Z");
      const hoursAfterBoot = (hours: number) => new Date(BOOT.getTime() + hours * 3_600_000);

      beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(BOOT);
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it("converts them for an agent granted knowledge_search after boot, without a restart", async () => {
        const artifactDir = join(tmpRoot, "artifacts");
        const corpus = join(tmpRoot, "corpus");
        await indexedBeforeTheBump(corpus, artifactDir);
        const [agent] = await db
          .insert(agents)
          .values({
            name: "Reader",
            model: "test-model",
            greetingMessage: "Hi",
            allowedTools: ["pinchy_read"],
            pluginConfig: { "pinchy-files": { allowed_paths: [corpus] } },
          })
          .returning();

        await runKbIndexWorkerTick({ deps: officeDeps(CLEAN), artifactDir });
        expect(await db.select().from(kbIndexJobs)).toEqual([]);

        await db
          .update(agents)
          .set({ allowedTools: ["pinchy_read", "knowledge_search"] })
          .where(eq(agents.id, agent.id));
        vi.setSystemTime(hoursAfterBoot(1));
        await runKbIndexWorkerTick({ deps: officeDeps(CLEAN), artifactDir });

        expect(await getLatestIndexJobForAgent(agent.id)).toMatchObject({
          status: "succeeded",
          trigger: "upgrade",
          paths: [corpus],
        });
        const [doc] = await db.select().from(kbDocuments);
        expect(doc.artifactFormatVersion).toBe(OFFICE_ARTIFACT_FORMAT_VERSION);
        expect(await documentText()).toContain(CLEAN);
      });

      it("runs a folder once, so a conversion that cannot finish now waits for a later run", async () => {
        const artifactDir = join(tmpRoot, "artifacts");
        const corpus = join(tmpRoot, "corpus");
        const earlierArtifact = await indexedBeforeTheBump(corpus, artifactDir);
        await knowledgeAgent(corpus);
        const squeezed = officeDeps(CLEAN, "infrastructure");

        await runKbIndexWorkerTick({ deps: squeezed, artifactDir });
        await runKbIndexWorkerTick({ deps: squeezed, artifactDir });

        const jobs = await db.select().from(kbIndexJobs);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({ status: "succeeded", trigger: "upgrade" });
        expect(jobs[0].counts).toMatchObject({ failed: 1 });
        // Still owed, so still hidden from search, and its directory still kept.
        const [doc] = await db.select().from(kbDocuments);
        expect(doc.artifactFormatVersion).toBeNull();
        expect(existsSync(earlierArtifact)).toBe(true);

        // A restart within the day finds the run on the record, and does not
        // send the folder round again.
        vi.setSystemTime(hoursAfterBoot(3));
        _resetKbIndexWorkerForTest();
        await runKbIndexWorkerTick({ deps: officeDeps(CLEAN), artifactDir });
        expect(await db.select().from(kbIndexJobs)).toHaveLength(1);

        // The next boot a day on asks again.
        vi.setSystemTime(hoursAfterBoot(25));
        _resetKbIndexWorkerForTest();
        await runKbIndexWorkerTick({ deps: officeDeps(CLEAN), artifactDir });
        expect(await db.select().from(kbIndexJobs)).toHaveLength(2);
        expect(existsSync(join(artifactDir, "v1"))).toBe(false);
      });

      it("tries a folder again six hours after its failed run started, not on the next hourly look", async () => {
        // A failed run is no evidence its folders were converted, so it does
        // not hold the folder back for a day. It does hold it back for a few
        // hours: the same outage would fail the next hourly run as well. The
        // hours count from when the run started, so however long it took to
        // fail, the next look six hours on runs the folder again.
        const artifactDir = join(tmpRoot, "artifacts");
        const corpus = join(tmpRoot, "corpus");
        await indexedBeforeTheBump(corpus, artifactDir);
        const agent = await knowledgeAgent(corpus);
        const outage = officeDeps(CLEAN);
        outage.embed = async () => {
          vi.setSystemTime(Date.now() + 40 * 60_000);
          throw new Error("connect ECONNREFUSED ollama.local:11434");
        };

        await runKbIndexWorkerTick({ deps: outage, artifactDir });
        expect(await db.select().from(kbIndexJobs)).toEqual([
          expect.objectContaining({ status: "failed", trigger: "upgrade" }),
        ]);

        for (const hours of [1, 5]) {
          vi.setSystemTime(hoursAfterBoot(hours));
          await runKbIndexWorkerTick({ deps: officeDeps(CLEAN), artifactDir });
        }
        expect(await db.select().from(kbIndexJobs)).toHaveLength(1);

        vi.setSystemTime(hoursAfterBoot(6));
        await runKbIndexWorkerTick({ deps: officeDeps(CLEAN), artifactDir });

        expect(await db.select().from(kbIndexJobs)).toHaveLength(2);
        expect(await getLatestIndexJobForAgent(agent.id)).toMatchObject({
          status: "succeeded",
          trigger: "upgrade",
        });
        const [doc] = await db.select().from(kbDocuments);
        expect(doc.artifactFormatVersion).toBe(OFFICE_ARTIFACT_FORMAT_VERSION);
      });

      it("runs a folder whose runs keep failing every six hours, four times a day, not every hour", async () => {
        // A share that failed to mount stays unmounted until someone fixes it.
        // Every run over it fails, and each writes two audit rows and replaces
        // the agent's last-run status: hourly, that is 24 runs a day. Each of
        // these runs takes a while to fail, and the six hours still count
        // from its start — so it is four a day, every day, not a run that
        // slips an hour later each time.
        const artifactDir = join(tmpRoot, "artifacts");
        const corpus = join(tmpRoot, "corpus");
        await indexedBeforeTheBump(corpus, artifactDir);
        await knowledgeAgent(corpus);
        rmSync(join(corpus, "Angebot.docx"));

        for (let hours = 0; hours < 48; hours++) {
          vi.setSystemTime(hoursAfterBoot(hours));
          await runKbIndexWorkerTick({ deps: officeDeps(CLEAN), artifactDir });
          await db
            .update(kbIndexJobs)
            .set({ finishedAt: sql`${kbIndexJobs.startedAt} + interval '40 minutes'` });
        }

        const jobs = await db.select().from(kbIndexJobs).orderBy(kbIndexJobs.startedAt);
        const startedAtHour = jobs.map(
          (job) => (job.startedAt!.getTime() - BOOT.getTime()) / 3_600_000
        );
        expect(startedAtHour).toEqual([0, 6, 12, 18, 24, 30, 36, 42]);
        expect(startedAtHour.filter((hour) => hour < 24)).toHaveLength(4);
        for (const job of jobs) {
          expect(job).toMatchObject({ status: "failed", trigger: "upgrade" });
          expect(job.error).toContain("check that it is mounted");
        }
        expect(await reindexAuditRows()).toHaveLength(16);
      });

      it("tries a folder again six hours on when a successful run could not read it", async () => {
        // A run that succeeded over its other folders never looked inside one
        // it had to leave as it was — a share that was briefly unmounted. That
        // folder's documents are as owed as before, so the run holds it back
        // only as long as a failed one would.
        const artifactDir = join(tmpRoot, "artifacts");
        const away = join(tmpRoot, "away");
        const reachable = join(tmpRoot, "reachable");
        const briefly = join(tmpRoot, "briefly");
        await indexedBeforeTheBump(briefly, artifactDir);
        await indexedBeforeTheBump(reachable, artifactDir);
        const agent = await knowledgeAgent([briefly, reachable]);
        renameSync(briefly, away);

        await runKbIndexWorkerTick({ deps: officeDeps(CLEAN), artifactDir });
        expect(await getLatestIndexJobForAgent(agent.id)).toMatchObject({
          status: "succeeded",
          trigger: "upgrade",
          unavailableFolders: 1,
        });
        renameSync(away, briefly);

        for (const hours of [1, 5]) {
          vi.setSystemTime(hoursAfterBoot(hours));
          await runKbIndexWorkerTick({ deps: officeDeps(CLEAN), artifactDir });
        }
        expect(await db.select().from(kbIndexJobs)).toHaveLength(1);

        vi.setSystemTime(hoursAfterBoot(6));
        await runKbIndexWorkerTick({ deps: officeDeps(CLEAN), artifactDir });

        expect(await db.select().from(kbIndexJobs)).toHaveLength(2);
        const docs = await db.select().from(kbDocuments);
        expect(docs).toHaveLength(2);
        expect(docs.map((doc) => doc.artifactFormatVersion)).toEqual([
          OFFICE_ARTIFACT_FORMAT_VERSION,
          OFFICE_ARTIFACT_FORMAT_VERSION,
        ]);
      });

      it("queues nothing and records nothing while the embedding model is missing, and runs once it is back", async () => {
        // The run could only fail. The nightly run and Reindex now already say
        // the model is missing; a failed run of ours every few hours would
        // only bury that under rows saying the same.
        const artifactDir = join(tmpRoot, "artifacts");
        const corpus = join(tmpRoot, "corpus");
        await indexedBeforeTheBump(corpus, artifactDir);
        const agent = await knowledgeAgent(corpus);
        mockKbEmbedderAvailable.mockReturnValue(false);
        const log = vi.spyOn(console, "log");
        const warn = vi.spyOn(console, "warn");

        await runKbIndexWorkerTick({ deps: officeDeps(CLEAN), artifactDir });
        expect(await queueReconversion(agent.id)).toEqual({ status: "skipped" });

        expect(await db.select().from(kbIndexJobs)).toEqual([]);
        expect(await reindexAuditRows()).toEqual([]);
        // The server log says why nothing runs, rather than that it does.
        const logged = [...log.mock.calls, ...warn.mock.calls].map((call) => String(call[0]));
        expect(logged).toContain(
          "[kb-index-worker] 1 agent(s) hold Office documents converted under an earlier format; their reindex is held until the bundled embedding model is back"
        );
        expect(logged.filter((line) => line.includes("reindexing them"))).toEqual([]);
        log.mockRestore();
        warn.mockRestore();

        mockKbEmbedderAvailable.mockReturnValue(true);
        vi.setSystemTime(hoursAfterBoot(1));
        await runKbIndexWorkerTick({ deps: officeDeps(CLEAN), artifactDir });

        expect(await getLatestIndexJobForAgent(agent.id)).toMatchObject({
          status: "succeeded",
          trigger: "upgrade",
        });
      });

      it("leaves a folder alone that an admin's reindex ran within the day", async () => {
        // Any run reads the whole folder and converts what it can. Following
        // it with a run of our own would read the corpus again for nothing.
        const artifactDir = join(tmpRoot, "artifacts");
        const corpus = join(tmpRoot, "corpus");
        await indexedBeforeTheBump(corpus, artifactDir);
        const agent = await knowledgeAgent(corpus);
        await enqueueIndexJob({
          orgId: DEFAULT_ORG_ID,
          agentId: agent.id,
          agentName: agent.name,
          requestedBy: "admin-1",
          paths: [corpus],
        });
        const squeezed = officeDeps(CLEAN, "infrastructure");

        await runKbIndexWorkerTick({ deps: squeezed, artifactDir });
        vi.setSystemTime(hoursAfterBoot(1));
        await runKbIndexWorkerTick({ deps: squeezed, artifactDir });

        const jobs = await db.select().from(kbIndexJobs);
        expect(jobs.map((job) => [job.trigger, job.status])).toEqual([["manual", "succeeded"]]);
        expect(squeezed.convertOffice).toHaveBeenCalledTimes(1);
      });

      /** A run over `corpus` that succeeded three hours before boot, under `version`'s rules. */
      async function ranBeforeBoot(
        agent: { id: string; name: string },
        corpus: string,
        artifactFormatVersion: number | null
      ) {
        await db.insert(kbIndexJobs).values({
          orgId: DEFAULT_ORG_ID,
          agentId: agent.id,
          agentName: agent.name,
          requestedBy: "kb-index-scheduler",
          paths: [corpus],
          trigger: "scheduled",
          status: "succeeded",
          startedAt: hoursAfterBoot(-4),
          finishedAt: hoursAfterBoot(-3),
          artifactFormatVersion,
        });
      }

      it.each([
        ["before its version was recorded", null],
        ["under the earlier rules", OFFICE_ARTIFACT_FORMAT_VERSION - 1],
      ])(
        "converts them at boot although a run %s went through the folder within the day",
        async (_, artifactFormatVersion) => {
          // The nightly run before the upgrade converted nothing under the new
          // rules. Counting it would leave the folder's documents hidden from
          // search for the rest of the day, with nothing queued to convert them.
          const artifactDir = join(tmpRoot, "artifacts");
          const corpus = join(tmpRoot, "corpus");
          await indexedBeforeTheBump(corpus, artifactDir);
          const agent = await knowledgeAgent(corpus);
          await ranBeforeBoot(agent, corpus, artifactFormatVersion);

          await runKbIndexWorkerTick({ deps: officeDeps(CLEAN), artifactDir });

          expect(await getLatestIndexJobForAgent(agent.id)).toMatchObject({
            status: "succeeded",
            trigger: "upgrade",
            paths: [corpus],
            artifactFormatVersion: OFFICE_ARTIFACT_FORMAT_VERSION,
          });
          const [doc] = await db.select().from(kbDocuments);
          expect(doc.artifactFormatVersion).toBe(OFFICE_ARTIFACT_FORMAT_VERSION);
          expect(await documentText()).toContain(CLEAN);
        }
      );

      it("leaves a folder alone that a run under the current rules went through before boot, within the day", async () => {
        const artifactDir = join(tmpRoot, "artifacts");
        const corpus = join(tmpRoot, "corpus");
        await indexedBeforeTheBump(corpus, artifactDir);
        const agent = await knowledgeAgent(corpus);
        await ranBeforeBoot(agent, corpus, OFFICE_ARTIFACT_FORMAT_VERSION);

        await runKbIndexWorkerTick({ deps: officeDeps(CLEAN), artifactDir });

        expect((await db.select().from(kbIndexJobs)).map((job) => job.trigger)).toEqual([
          "scheduled",
        ]);
      });

      it("runs a folder holding a document that cannot be converted at most once a day, whatever starts the run", async () => {
        // The nightly run and the worker's hourly look both reach the folder.
        // A document that ends `infrastructure` every time stays owed, and
        // each of them must see the other's run, across a restart too.
        const artifactDir = join(tmpRoot, "artifacts");
        const corpus = join(tmpRoot, "corpus");
        await indexedBeforeTheBump(corpus, artifactDir);
        const agent = await knowledgeAgent(corpus);
        const nightly = () =>
          enqueueIndexJob({
            orgId: DEFAULT_ORG_ID,
            agentId: agent.id,
            agentName: agent.name,
            requestedBy: "kb-index-scheduler",
            paths: [corpus],
            trigger: "scheduled",
          });
        const squeezed = officeDeps(CLEAN, "infrastructure");

        await nightly();
        await runKbIndexWorkerTick({ deps: squeezed, artifactDir });
        for (const hours of [1, 6, 12, 23]) {
          vi.setSystemTime(hoursAfterBoot(hours));
          if (hours === 6) _resetKbIndexWorkerForTest();
          await runKbIndexWorkerTick({ deps: squeezed, artifactDir });
        }
        vi.setSystemTime(hoursAfterBoot(24.5));
        await nightly();
        await runKbIndexWorkerTick({ deps: squeezed, artifactDir });

        const jobs = await db.select().from(kbIndexJobs);
        expect(jobs.map((job) => job.trigger)).toEqual(["scheduled", "scheduled"]);
        expect(squeezed.convertOffice).toHaveBeenCalledTimes(2);
      });

      it("tries a folder whose conversion could not finish again the next day, and not before", async () => {
        const artifactDir = join(tmpRoot, "artifacts");
        const corpus = join(tmpRoot, "corpus");
        await indexedBeforeTheBump(corpus, artifactDir);
        await knowledgeAgent(corpus);
        const squeezed = officeDeps(CLEAN, "infrastructure");
        const convert = squeezed.convertOffice;
        // Each run takes a while: the clock moves on while it converts.
        squeezed.convertOffice = vi.fn(
          async (sources: Parameters<IngestDeps["convertOffice"]>[0]) => {
            vi.setSystemTime(Date.now() + 40 * 60_000);
            return convert(sources);
          }
        );

        await runKbIndexWorkerTick({ deps: squeezed, artifactDir });
        expect(await db.select().from(kbIndexJobs)).toHaveLength(1);

        // Looked at again within the day, the document is still owed — and its
        // folder was run for it already, so nothing is queued.
        for (const hours of [1, 2, 12, 23]) {
          vi.setSystemTime(hoursAfterBoot(hours));
          await runKbIndexWorkerTick({ deps: squeezed, artifactDir });
        }
        expect(await db.select().from(kbIndexJobs)).toHaveLength(1);

        // The day counts from when the run started, however long it took.
        vi.setSystemTime(hoursAfterBoot(24));
        await runKbIndexWorkerTick({ deps: squeezed, artifactDir });
        expect(await db.select().from(kbIndexJobs)).toHaveLength(2);
        vi.setSystemTime(hoursAfterBoot(27));
        await runKbIndexWorkerTick({ deps: squeezed, artifactDir });

        const jobs = await db.select().from(kbIndexJobs);
        expect(jobs).toHaveLength(2);
        expect(jobs.every((job) => job.trigger === "upgrade")).toBe(true);
        expect(squeezed.convertOffice).toHaveBeenCalledTimes(2);
      });
    });
  });

  // Requeueing is a BOOT act: it is only sound because a `running` job at
  // startup belongs to a process that no longer exists. Repeat it on a later
  // tick and that premise is false — the `running` job it finds is the one this
  // process is working on right now, and resetting it flips a live run to
  // `pending`, blanks its total, and makes every status read lie for hours.
  it("never requeues again once it is running, so it cannot reset a live job", async () => {
    const agent = await makeAgent();
    writePdf(tmpRoot, "handbook.pdf");
    await enqueueIndexJob({
      orgId: ORG_ID,
      agentId: agent.id,
      agentName: agent.name,
      requestedBy: "admin-1",
      paths: [tmpRoot],
    });

    await runKbIndexWorkerTick({ deps: fakeDeps() });

    // Stand in for a job this process has claimed and is embedding right now.
    const startedAt = new Date();
    await db
      .update(kbIndexJobs)
      .set({ status: "running", startedAt, processed: 30, total: 42, finishedAt: null });

    await runKbIndexWorkerTick({ deps: fakeDeps() });

    const job = await getLatestIndexJobForAgent(agent.id);
    expect(job?.status).toBe("running");
    expect(job?.processed).toBe(30);
    expect(job?.total).toBe(42);
    expect(job?.startedAt).toEqual(startedAt);
  });
});
