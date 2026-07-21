import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

  it("surfaces a concurrent-run conflict (409) as an error toast", async () => {
    const user = userEvent.setup();
    mockPost.mockRejectedValue(new ApiError(409, "A knowledge base reindex is already running"));

    render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /reindex/i })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /reindex/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("A knowledge base reindex is already running")
    );
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
