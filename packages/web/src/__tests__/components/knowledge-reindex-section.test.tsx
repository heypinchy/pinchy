import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import { KnowledgeReindexSection } from "@/components/knowledge-reindex-section";
import { apiGet, apiPost, ApiError } from "@/lib/api-client";
import { toast } from "sonner";

// Mock the network layer but keep the REAL ApiError class so the component's
// `instanceof ApiError` branch is exercised against the same constructor.
vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiGet: vi.fn(), apiPost: vi.fn() };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), message: vi.fn() },
}));

const mockGet = vi.mocked(apiGet);
const mockPost = vi.mocked(apiPost);

type Job = {
  id: string;
  status: "pending" | "running" | "succeeded" | "failed";
  processed: number;
  total: number | null;
  counts: {
    indexed: number;
    skipped: number;
    removed: number;
    unsearchable: number;
    failed: number;
  } | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

function job(overrides: Partial<Job>): Job {
  return {
    id: "job-1",
    status: "succeeded",
    processed: 0,
    total: 0,
    counts: null,
    error: null,
    createdAt: "2026-07-21T10:00:00.000Z",
    startedAt: "2026-07-21T10:00:01.000Z",
    finishedAt: "2026-07-21T10:05:00.000Z",
    ...overrides,
  };
}

describe("KnowledgeReindexSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ job: null });
  });

  it("shows a 'not yet indexed' state and an enabled trigger when directories are granted", async () => {
    render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} />);

    await waitFor(() => expect(screen.getByRole("button", { name: /reindex/i })).toBeEnabled());
    expect(screen.getByText(/not.*indexed/i)).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith("/api/agents/a1/knowledge/reindex");
  });

  it("disables the trigger and explains why when no directories are granted", async () => {
    render(<KnowledgeReindexSection agentId="a1" allowedPathCount={0} />);

    await waitFor(() => expect(screen.getByRole("button", { name: /reindex/i })).toBeDisabled());
    expect(screen.getByText(/grant.*director/i)).toBeInTheDocument();
  });

  it("triggers a reindex and then reflects live progress from polling", async () => {
    const user = userEvent.setup();
    mockPost.mockResolvedValue({ jobId: "job-9", status: "pending", pathCount: 2 });
    // After the POST, the first poll returns a running job at 3/10.
    mockGet
      .mockResolvedValueOnce({ job: null }) // initial mount fetch
      .mockResolvedValue({
        job: job({ status: "running", processed: 3, total: 10, counts: null }),
      });

    render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} pollIntervalMs={20} />);

    await waitFor(() => expect(screen.getByRole("button", { name: /reindex/i })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /reindex/i }));

    expect(mockPost).toHaveBeenCalledWith("/api/agents/a1/knowledge/reindex", {});

    // Progress surfaces the processed/total the poll reports.
    await waitFor(() => expect(screen.getByText(/3/)).toBeInTheDocument());
    expect(screen.getByText(/10/)).toBeInTheDocument();
    // The trigger is disabled while a run is in flight.
    expect(screen.getByRole("button", { name: /reindex/i })).toBeDisabled();
  });

  it("summarizes the last successful run, emphasizing unsearchable and failed docs", async () => {
    mockGet.mockResolvedValue({
      job: job({
        status: "succeeded",
        processed: 100,
        total: 100,
        counts: { indexed: 90, skipped: 5, removed: 0, unsearchable: 4, failed: 1 },
      }),
    });

    render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} />);

    await waitFor(() => expect(screen.getByText(/last indexed/i)).toBeInTheDocument());
    // The counters that mean "this document will never answer a question".
    expect(screen.getByText(/4/)).toBeInTheDocument(); // unsearchable
    expect(screen.getByText(/unsearchable/i)).toBeInTheDocument();
    expect(screen.getByText(/failed/i)).toBeInTheDocument();
    // Button is enabled again — the run is over.
    expect(screen.getByRole("button", { name: /reindex/i })).toBeEnabled();
  });

  it("surfaces a concurrent-run conflict (409) as an error toast naming the blocking agent", async () => {
    const user = userEvent.setup();
    // The real route puts the blocking agent's name INTO the message — the only
    // field ApiError carries to the toast (the `agent` sibling field is lost).
    const message = 'A knowledge base reindex is already running for agent "Legal KB"';
    mockPost.mockRejectedValue(new ApiError(409, message));

    render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /reindex/i })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /reindex/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message));
  });

  it("surfaces a missing embedder (503) as an error toast with the route's message", async () => {
    const user = userEvent.setup();
    mockPost.mockRejectedValue(new ApiError(503, "Knowledge base embedding model not available"));

    render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /reindex/i })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /reindex/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Knowledge base embedding model not available")
    );
    // No phantom run to watch — the button recovers.
    expect(screen.getByRole("button", { name: /reindex/i })).toBeEnabled();
  });

  it("names the discovery phase instead of faking a percentage while total is unknown", async () => {
    mockGet.mockResolvedValue({
      job: job({ status: "running", processed: 0, total: null }),
    });

    render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} />);

    await waitFor(() => expect(screen.getByText(/discovering documents/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /reindex/i })).toBeDisabled();
  });

  it("renders a failed run as a destructive alert with the error and the counts", async () => {
    mockGet.mockResolvedValue({
      job: job({
        status: "failed",
        processed: 40,
        total: 100,
        error: "Embedding model crashed",
        counts: { indexed: 30, skipped: 9, removed: 0, unsearchable: 0, failed: 1 },
      }),
    });

    render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} />);

    await waitFor(() => expect(screen.getByText(/last reindex failed/i)).toBeInTheDocument());
    expect(screen.getByText("Embedding model crashed")).toBeInTheDocument();
    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
    // A failed run is over — the admin can immediately try again.
    expect(screen.getByRole("button", { name: /reindex/i })).toBeEnabled();
  });

  it("clamps the progress bar at 100% even if processed overshoots total", async () => {
    mockGet.mockResolvedValue({
      job: job({ status: "running", processed: 12, total: 10 }),
    });

    render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} />);

    const bar = await screen.findByRole("progressbar");
    await waitFor(() => expect(bar).toHaveAttribute("aria-valuenow", "100"));
  });

  it("warns that a reindex uses the saved grants while directory changes are unsaved", async () => {
    render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} hasUnsavedPathChanges />);

    await waitFor(() => expect(screen.getByRole("button", { name: /reindex/i })).toBeEnabled());
    expect(screen.getByText(/saved grants/i)).toBeInTheDocument();
  });

  it("ignores a slow status read that resolves after a reindex was triggered", async () => {
    const user = userEvent.setup();
    let resolveMountGet!: (value: { job: Job | null }) => void;
    mockGet
      // The mount-time GET hangs until we resolve it by hand, mid-run.
      .mockImplementationOnce(
        () =>
          new Promise<{ job: Job | null }>((resolve) => {
            resolveMountGet = resolve;
          })
      )
      .mockResolvedValue({
        job: job({ status: "running", processed: 1, total: 5, counts: null }),
      });
    mockPost.mockResolvedValue({ jobId: "job-9", status: "pending", pathCount: 2 });

    // This scenario is about the fetch-sequence guard dropping a stale mount
    // read, NOT about polling. An effectively-idle poll interval keeps the test
    // deterministic: the old `toHaveBeenCalledTimes(2)` assertion raced a live
    // 20ms interval and flaked to a much higher count under load.
    render(
      <KnowledgeReindexSection agentId="a1" allowedPathCount={2} pollIntervalMs={1_000_000} />
    );
    await user.click(screen.getByRole("button", { name: /reindex/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /reindexing/i })).toBeDisabled());

    // The pre-click read finally answers "no job ever ran". It is stale — it
    // must not clear the run the admin just started and is watching. Flush its
    // resolution so the guard's decision (drop it) is fully applied before we assert.
    await act(async () => {
      resolveMountGet({ job: null });
    });
    expect(screen.getByRole("button", { name: /reindexing/i })).toBeDisabled();
  });

  it("treats a server-side no-op (nothing to index) as info, not an error", async () => {
    const user = userEvent.setup();
    mockPost.mockResolvedValue({ jobId: null, status: "noop", pathCount: 0 });

    render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /reindex/i })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /reindex/i }));

    await waitFor(() => expect(toast.info).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
    // No phantom running state — the button stays usable.
    expect(screen.getByRole("button", { name: /reindex/i })).toBeEnabled();
  });
});
