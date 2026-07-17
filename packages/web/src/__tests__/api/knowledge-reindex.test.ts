import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { DEFAULT_ORG_ID } from "@/lib/knowledge/constants";
import type { KbIndexJob } from "@/lib/knowledge/index-jobs";
import type { IngestResult } from "@/lib/knowledge/types";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

const mockLimit = vi.fn();
const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
vi.mock("@/db", () => ({
  db: { select: (...args: unknown[]) => mockSelect(...args) },
}));

vi.mock("@/db/schema", () => ({
  activeAgents: { __table: "active_agents", id: "active_agents.id" },
}));

const mockGetSetting = vi.fn();
vi.mock("@/lib/settings", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
}));

const mockEnqueueIndexJob = vi.fn();
const mockGetLatestIndexJobForAgent = vi.fn();
vi.mock("@/lib/knowledge/index-jobs", () => ({
  enqueueIndexJob: (...args: unknown[]) => mockEnqueueIndexJob(...args),
  getLatestIndexJobForAgent: (...args: unknown[]) => mockGetLatestIndexJobForAgent(...args),
}));

const mockDeferAuditLog = vi.fn();
vi.mock("@/lib/audit-deferred", () => ({
  deferAuditLog: (...args: unknown[]) => mockDeferAuditLog(...args),
}));

// ── Helpers ──────────────────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/agents/agent-1/knowledge/reindex", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeGetRequest() {
  return new NextRequest("http://localhost/api/agents/agent-1/knowledge/reindex");
}

/** An IngestResult with every counter at zero, overridden by `counts`. Typed so a counter added to ingest fails to compile here rather than silently vanishing from what an admin sees. */
function ingestResult(counts: Partial<IngestResult> = {}): IngestResult {
  return { indexed: 0, skipped: 0, removed: 0, unsearchable: 0, failed: 0, ...counts };
}

function makeJob(overrides: Partial<KbIndexJob> = {}): KbIndexJob {
  return {
    id: "job-1",
    orgId: DEFAULT_ORG_ID,
    agentId: "agent-1",
    agentName: "Smithers",
    requestedBy: "admin-1",
    paths: ["/data/hr", "/data/legal"],
    status: "pending",
    total: null,
    processed: 0,
    counts: null,
    error: null,
    createdAt: new Date("2026-07-17T10:00:00Z"),
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

const ctx = { params: Promise.resolve({ agentId: "agent-1" }) };

const agentRow = {
  id: "agent-1",
  name: "Smithers",
  pluginConfig: { "pinchy-files": { allowed_paths: ["/data/hr", "/data/legal"] } },
};

describe("POST /api/agents/[agentId]/knowledge/reindex", () => {
  let POST: typeof import("@/app/api/agents/[agentId]/knowledge/reindex/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { id: "admin-1", role: "admin" } });
    mockLimit.mockResolvedValue([agentRow]);
    mockGetSetting.mockResolvedValue("http://ollama.local:11434");
    mockEnqueueIndexJob.mockResolvedValue({ status: "queued", job: makeJob() });
    POST = (await import("@/app/api/agents/[agentId]/knowledge/reindex/route")).POST;
  });

  it("returns 401 when unauthenticated and never enqueues", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const res = await POST(makeRequest(), ctx as never);
    expect(res.status).toBe(401);
    expect(mockEnqueueIndexJob).not.toHaveBeenCalled();
  });

  it("returns 403 for an authenticated non-admin and never enqueues", async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: "user-1", role: "member" } });
    const res = await POST(makeRequest(), ctx as never);
    expect(res.status).toBe(403);
    expect(mockEnqueueIndexJob).not.toHaveBeenCalled();
  });

  it("returns 404 when the agent does not exist (or is deleted) and never enqueues", async () => {
    mockLimit.mockResolvedValueOnce([]);
    const res = await POST(makeRequest(), ctx as never);
    expect(res.status).toBe(404);
    expect(mockEnqueueIndexJob).not.toHaveBeenCalled();
  });

  // The whole point of #714: a real corpus is hours of embedding, so the
  // request hands back a job to watch instead of blocking until it is done.
  it("queues a job for every granted folder and answers 202 with the job to poll", async () => {
    const res = await POST(makeRequest(), ctx as never);

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      jobId: "job-1",
      status: "pending",
      pathCount: 2,
    });

    expect(mockEnqueueIndexJob).toHaveBeenCalledTimes(1);
    expect(mockEnqueueIndexJob.mock.calls[0][0]).toMatchObject({
      orgId: DEFAULT_ORG_ID,
      agentId: "agent-1",
      // Snapshotted onto the job so the outcome row can still name the agent
      // hours later, and so the worker indexes what was authorized when asked.
      agentName: "Smithers",
      requestedBy: "admin-1",
      paths: ["/data/hr", "/data/legal"],
    });
  });

  it("narrows to the requested subset but never past the agent's granted folders", async () => {
    // /data/legal is granted; /etc/passwd is NOT — it must be dropped, not queued.
    const res = await POST(makeRequest({ paths: ["/data/legal", "/etc/passwd"] }), ctx as never);
    expect(res.status).toBe(202);
    expect(mockEnqueueIndexJob.mock.calls[0][0].paths).toEqual(["/data/legal"]);
  });

  // Serialized per org by the job store. Rejecting with the blocking job's id
  // is what lets the admin watch the run that is actually happening instead of
  // clicking again into a queue that will never grow.
  it("returns 409 with the in-flight job when the org is already reindexing", async () => {
    mockEnqueueIndexJob.mockResolvedValueOnce({
      status: "busy",
      job: makeJob({ id: "job-running", status: "running", processed: 30, total: 42 }),
    });

    const res = await POST(makeRequest(), ctx as never);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("already"),
      jobId: "job-running",
      status: "running",
    });

    const entry = mockDeferAuditLog.mock.calls[0][0];
    expect(entry.outcome).toBe("failure");
    expect(entry.detail.jobId).toBe("job-running");
    expect(entry.detail.reason).toBe("index_job_already_running");
  });

  it("returns 200 and never enqueues when the agent has no granted folders", async () => {
    mockLimit.mockResolvedValueOnce([{ id: "agent-1", name: "Smithers", pluginConfig: null }]);
    const res = await POST(makeRequest(), ctx as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: null, status: "noop", pathCount: 0 });
    expect(mockEnqueueIndexJob).not.toHaveBeenCalled();

    // A no-op reindex is still audited (success, no job).
    expect(mockDeferAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockDeferAuditLog.mock.calls[0][0];
    expect(entry.eventType).toBe("knowledge.reindex");
    expect(entry.outcome).toBe("success");
    expect(entry.detail.pathCount).toBe(0);
    expect(entry.detail.jobId).toBeUndefined();
  });

  // Fast feedback beats a job that queues, waits, and fails hours later with
  // the same information.
  it("returns 503 and audits a failure when the embedding endpoint is not configured", async () => {
    mockGetSetting.mockResolvedValueOnce(null);
    const res = await POST(makeRequest(), ctx as never);
    expect(res.status).toBe(503);
    expect(mockEnqueueIndexJob).not.toHaveBeenCalled();

    expect(mockDeferAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockDeferAuditLog.mock.calls[0][0];
    expect(entry.eventType).toBe("knowledge.reindex");
    expect(entry.outcome).toBe("failure");
    expect(entry.detail.reason).toBe("ollama_not_configured");
  });

  it("returns 500 and audits a failure when enqueueing throws", async () => {
    mockEnqueueIndexJob.mockRejectedValueOnce(new Error("db exploded"));
    const res = await POST(makeRequest(), ctx as never);
    expect(res.status).toBe(500);

    expect(mockDeferAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockDeferAuditLog.mock.calls[0][0];
    expect(entry.eventType).toBe("knowledge.reindex");
    expect(entry.outcome).toBe("failure");
  });

  it("audits the request with an {id,name} agent ref, the jobId, and no raw filesystem path/PII", async () => {
    const res = await POST(makeRequest(), ctx as never);
    expect(res.status).toBe(202);

    expect(mockDeferAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockDeferAuditLog.mock.calls[0][0];
    expect(entry.eventType).toBe("knowledge.reindex");
    expect(entry.actorType).toBe("user");
    expect(entry.actorId).toBe("admin-1");
    expect(entry.outcome).toBe("success");
    expect(entry.detail.agent).toEqual({ id: "agent-1", name: "Smithers" });
    expect(entry.detail).toMatchObject({ pathCount: 2, jobId: "job-1" });

    // Counters are absent, not zero: nothing has been counted yet, and zeros
    // here would record an empty corpus for every reindex ever started.
    expect(entry.detail.indexed).toBeUndefined();
    expect(entry.detail.failed).toBeUndefined();

    // No full filesystem paths (which can embed usernames) in the audit detail.
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("/data/hr");
    expect(serialized).not.toContain("/data/legal");
    expect(serialized).not.toMatch(/[^\s@]+@[^\s@]+\.[^\s@]+/); // no email-shaped strings
  });
});

describe("GET /api/agents/[agentId]/knowledge/reindex", () => {
  let GET: typeof import("@/app/api/agents/[agentId]/knowledge/reindex/route").GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { id: "admin-1", role: "admin" } });
    mockLimit.mockResolvedValue([agentRow]);
    GET = (await import("@/app/api/agents/[agentId]/knowledge/reindex/route")).GET;
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    expect((await GET(makeGetRequest(), ctx as never)).status).toBe(401);
  });

  it("returns 403 for an authenticated non-admin — index state is admin-only, like the reindex itself", async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: "user-1", role: "member" } });
    expect((await GET(makeGetRequest(), ctx as never)).status).toBe(403);
  });

  it("returns 404 when the agent does not exist", async () => {
    mockLimit.mockResolvedValueOnce([]);
    expect((await GET(makeGetRequest(), ctx as never)).status).toBe(404);
  });

  it("reports no job for an agent that has never been reindexed", async () => {
    mockGetLatestIndexJobForAgent.mockResolvedValueOnce(null);
    const res = await GET(makeGetRequest(), ctx as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ job: null });
  });

  it("reports progress while a run is in flight", async () => {
    mockGetLatestIndexJobForAgent.mockResolvedValueOnce(
      makeJob({
        status: "running",
        processed: 30,
        total: 42,
        startedAt: new Date("2026-07-17T10:00:05Z"),
      })
    );

    const res = await GET(makeGetRequest(), ctx as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      job: { id: "job-1", status: "running", processed: 30, total: 42, counts: null },
    });
  });

  // This endpoint is now the only place an admin sees the counts, so the two
  // that mean "this file will never answer a question" have to survive the trip
  // from the worker to here. Dropping them would restore exactly the false
  // "everything indexed" the ingest counters exist to prevent.
  it("reports unsearchable and failed files on a finished run", async () => {
    mockGetLatestIndexJobForAgent.mockResolvedValueOnce(
      makeJob({
        status: "succeeded",
        processed: 9,
        total: 9,
        counts: ingestResult({ indexed: 5, skipped: 1, unsearchable: 2, failed: 1 }),
        finishedAt: new Date("2026-07-17T11:00:00Z"),
      })
    );

    const res = await GET(makeGetRequest(), ctx as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job.status).toBe("succeeded");
    expect(body.job.counts).toEqual(
      ingestResult({ indexed: 5, skipped: 1, unsearchable: 2, failed: 1 })
    );
  });

  it("reports why a failed run failed", async () => {
    mockGetLatestIndexJobForAgent.mockResolvedValueOnce(
      makeJob({
        status: "failed",
        processed: 3,
        total: 42,
        counts: ingestResult({ indexed: 3 }),
        error: "connect ECONNREFUSED",
        finishedAt: new Date("2026-07-17T11:00:00Z"),
      })
    );

    const res = await GET(makeGetRequest(), ctx as never);

    const body = await res.json();
    expect(body.job).toMatchObject({ status: "failed", error: "connect ECONNREFUSED" });
  });

  // Not a PII boundary — the admin granted these folders and can see them in
  // the permissions UI. The response is a projection of the run's STATE, and
  // paths are its input; shipping the job row wholesale would also mean
  // shipping the enqueue-time snapshot, which can disagree with the grants the
  // admin is looking at right now. Report what the run is doing, nothing else.
  it("reports the run's state without echoing the job's path snapshot", async () => {
    mockGetLatestIndexJobForAgent.mockResolvedValueOnce(makeJob({ status: "running" }));

    const res = await GET(makeGetRequest(), ctx as never);

    const serialized = JSON.stringify(await res.json());
    expect(serialized).not.toContain("/data/hr");
    expect(serialized).not.toContain("/data/legal");
  });
});
