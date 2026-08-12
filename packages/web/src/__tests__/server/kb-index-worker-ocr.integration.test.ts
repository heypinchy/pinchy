/**
 * The worker's OCR wiring (#941): the tally the extractor feeds, the usage row
 * the run leaves behind, and the audit detail's exact shape — asserted at the
 * wire, against a real Postgres.
 *
 * The sibling suite (`kb-index-worker.integration.test.ts`) injects `opts.deps`
 * and therefore never enters `resolveIngestDeps`, which is where all of the OCR
 * plumbing lives. This file takes the other route: no injected deps, and the
 * collaborators `resolveIngestDeps` imports are module-mocked instead. Each
 * seam keeps its own owner — the scan DECISION is `pdf-ocr.test.ts`, the model
 * RESOLUTION is `kb-ocr.test.ts`; what is asserted here is only what the
 * worker itself adds on top of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { and, eq, like } from "drizzle-orm";

import { db } from "@/db";
import { agents, auditLog, kbIndexJobs, usageRecords } from "@/db/schema";
import { enqueueIndexJob } from "@/lib/knowledge/index-jobs";
import { runNextIndexJob, _resetKbIndexWorkerForTest } from "@/server/kb-index-worker";

vi.mock("@/lib/knowledge/kb-embedder", () => ({
  kbEmbedderAvailable: () => true,
  kbEmbeddingConfig: () => ({}),
}));
vi.mock("@/lib/knowledge/embeddings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/knowledge/embeddings")>()),
  embedTexts: vi.fn(async (texts: string[]) => texts.map(() => Array(768).fill(0.01))),
}));
vi.mock("@/lib/knowledge/kb-ocr", () => ({ resolveKbOcr: vi.fn() }));
vi.mock("@/lib/knowledge/pdf-extract", () => ({ extractPdfPages: vi.fn() }));

const { resolveKbOcr } = await import("@/lib/knowledge/kb-ocr");
const { extractPdfPages } = await import("@/lib/knowledge/pdf-extract");
const mockResolveKbOcr = vi.mocked(resolveKbOcr);
const mockExtractPdfPages = vi.mocked(extractPdfPages);

const ORG_ID = "org-kb-worker-ocr-test";
const OCR_MODEL = "anthropic/claude-haiku-4-5-20251001";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-kb-worker-ocr-test-"));
  await db.delete(kbIndexJobs);
  await db.delete(usageRecords).where(like(usageRecords.sessionKey, "kb-index:%"));
  _resetKbIndexWorkerForTest();
  vi.clearAllMocks();

  // The extractor is mocked at the module seam, but it still honours the OCR
  // contract the real one implements: run the injected vision call on the one
  // scanned page and report the document. `skipped: 2` stands in for a cap
  // that left pages behind — the count that must reach the audit row.
  mockExtractPdfPages.mockImplementation(async (_absPath, opts) => {
    const ocr = opts?.ocr;
    if (!ocr) return [{ page: 1, text: "" }];
    const text = (await ocr.ocrPage(Buffer.from("png-bytes"))) ?? "";
    ocr.onDocumentOcr?.({ rendered: 1, skipped: 2 });
    return [{ page: 1, text }];
  });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function makeAgent(name = "Smithers") {
  const [agent] = await db
    .insert(agents)
    .values({ name, model: "test-model", greetingMessage: "Hi" })
    .returning();
  return agent;
}

function seedScanPdf(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "certificate.pdf"), "fake-scan-bytes");
}

async function enqueueAndRun() {
  const agent = await makeAgent();
  const dir = join(tmpRoot, "docs");
  seedScanPdf(dir);
  const { job } = await enqueueIndexJob({
    orgId: ORG_ID,
    agentId: agent.id,
    agentName: agent.name,
    requestedBy: "admin-1",
    paths: [dir],
  });
  const ran = await runNextIndexJob();
  expect(ran).not.toBeNull();
  return { agent, job };
}

async function outcomeAuditDetail(jobId: string) {
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.eventType, "knowledge.reindex"), eq(auditLog.actorType, "system")));
  const row = rows.find((r) => (r.detail as { jobId?: string }).jobId === jobId);
  expect(row).toBeDefined();
  return row!.detail as Record<string, unknown>;
}

describe("with a vision model resolved", () => {
  beforeEach(() => {
    mockResolveKbOcr.mockImplementation(async (deps) => ({
      model: OCR_MODEL,
      ocrPage: async () => {
        // The real resolveKbOcr reports usage through the deps the WORKER
        // passed in — that hand-off is exactly the wiring under test.
        deps?.onUsage?.({ inputTokens: 900, outputTokens: 40 });
        return "AFNOR VALIDATION";
      },
    }));
  });

  it("writes one usage row for the run, keyed to the job", async () => {
    // "Pinchy writes a usage record whenever an LLM call completes" is the
    // Usage Dashboard's promise; index-time OCR spends real tokens against the
    // operator's own key and must not spend them invisibly.
    const { agent, job } = await enqueueAndRun();

    const rows = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.sessionKey, `kb-index:${job.id}`));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: "system",
      agentId: agent.id,
      model: OCR_MODEL,
      inputTokens: 900,
      outputTokens: 40,
    });
  });

  it("audits exactly the documented ocr fields — counts and the model, no token totals", async () => {
    const { job } = await enqueueAndRun();

    const detail = await outcomeAuditDetail(job.id);

    // toEqual, not toMatchObject: the row is HMAC-signed and immutable, and
    // the docs enumerate exactly these four fields. The tally the worker holds
    // also carries token counters (for the usage row above); those leaking in
    // here is the regression this pins out.
    expect(detail.ocr).toEqual({
      model: OCR_MODEL,
      documents: 1,
      pages: 1,
      skippedPages: 2,
    });
  });
});

describe("without a vision model", () => {
  beforeEach(() => {
    mockResolveKbOcr.mockResolvedValue(null);
  });

  it("writes no usage row and no ocr detail", async () => {
    const { job } = await enqueueAndRun();

    const rows = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.sessionKey, `kb-index:${job.id}`));
    expect(rows).toHaveLength(0);

    // Absent, not zeroed: a missing field reads as "nothing was sent".
    const detail = await outcomeAuditDetail(job.id);
    expect(detail).not.toHaveProperty("ocr");
  });
});
