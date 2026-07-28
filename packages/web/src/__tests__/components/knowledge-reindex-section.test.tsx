// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import { flushPendingRenders } from "@/test-helpers/react";
import { KnowledgeReindexSection, formatElapsed } from "@/components/knowledge-reindex-section";
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

// The unsearchable-document list owns its own read (and is tested on its own in
// knowledge-unsearchable-list.test.tsx). Stubbed here so this file keeps testing
// ONE network conversation, with the props rendered as attributes so the
// section's decisions about WHEN to show it stay assertable.
vi.mock("@/components/knowledge-unsearchable-list", () => ({
  KnowledgeUnsearchableList: (props: {
    agentId: string;
    announceNone: boolean;
    reloadKey: string;
  }) => (
    <div
      data-testid="unsearchable-list"
      data-agent-id={props.agentId}
      data-announce-none={String(props.announceNone)}
      data-reload-key={props.reloadKey}
    />
  ),
}));

const mockGet = vi.mocked(apiGet);
const mockPost = vi.mocked(apiPost);

type Job = {
  id: string;
  status: "pending" | "running" | "succeeded" | "failed";
  processed: number;
  total: number | null;
  processedBytes: number;
  totalBytes: number | null;
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
    processedBytes: 0,
    totalBytes: null,
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

  it("does not poll while no run is active", async () => {
    // Idle state: the mount read answers "no job", so the poll effect must not
    // register an interval at all. This pins the property the old
    // `toHaveBeenCalledTimes(2)` in the stale-read test asserted by accident.
    render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} pollIntervalMs={20} />);

    await waitFor(() => expect(screen.getByRole("button", { name: /reindex/i })).toBeEnabled());
    // Give several would-be interval periods a chance to fire. Flake-safe as an
    // absence assertion: with no interval registered the count can never grow,
    // so load can only make a regression MORE visible, never a pass less so.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(mockGet).toHaveBeenCalledTimes(1); // the mount read only
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

  // #935: the reindex summary counts unsearchable documents; the list beside it
  // names them. Which documents an admin may see is the route's business — this
  // is only about when the section asks for them at all.
  describe("unsearchable documents", () => {
    it("shows the list beside the counts once a run has finished, and lets it announce zero", async () => {
      mockGet.mockResolvedValue({
        job: job({
          status: "succeeded",
          counts: { indexed: 90, skipped: 5, removed: 0, unsearchable: 4, failed: 1 },
        }),
      });

      render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} />);

      const list = await screen.findByTestId("unsearchable-list");
      expect(list).toHaveAttribute("data-agent-id", "a1");
      expect(list).toHaveAttribute("data-announce-none", "true");
    });

    // The index is corpus-wide: another agent's run can have left unsearchable
    // documents inside this agent's scope, so the list is still asked for — it
    // just may not reassure about a zero it has no run to stand on.
    it("still shows the list before any run of its own, but without announcing zero", async () => {
      render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} />);

      const list = await screen.findByTestId("unsearchable-list");
      expect(list).toHaveAttribute("data-announce-none", "false");
    });

    // A failed run stopped somewhere; what it indexed before that is a partial
    // corpus. Listing what it found is useful, but "every document came back
    // with searchable text" printed under "Last reindex failed" is an all-clear
    // about a run that never finished — the one place this panel could add a
    // false reassurance instead of removing one.
    it("shows the list after a failed run but never lets it announce zero", async () => {
      mockGet.mockResolvedValue({
        job: job({ status: "failed", error: "Embedding model failed to load" }),
      });

      render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} />);

      const list = await screen.findByTestId("unsearchable-list");
      expect(list).toHaveAttribute("data-announce-none", "false");
    });

    it("hides the list while a run is in flight", async () => {
      mockGet.mockResolvedValue({ job: job({ status: "running", processed: 3, total: 10 }) });

      render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} />);

      await waitFor(() => expect(screen.getByText(/indexing 3 of 10/i)).toBeInTheDocument());
      expect(screen.queryByTestId("unsearchable-list")).not.toBeInTheDocument();
    });

    it("hides the list when no directory is granted", async () => {
      render(<KnowledgeReindexSection agentId="a1" allowedPathCount={0} />);

      await waitFor(() => expect(screen.getByRole("button", { name: /reindex/i })).toBeDisabled());
      expect(screen.queryByTestId("unsearchable-list")).not.toBeInTheDocument();
    });

    // Both inputs that can invalidate the list: a finished run (new findings)
    // and a changed grant count (a different scope to report on).
    it("re-reads the list after a finished run and after a grant change", async () => {
      mockGet.mockResolvedValue({ job: job({ id: "job-1", status: "succeeded" }) });
      const first = render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} />);
      const afterJob1 = (await screen.findByTestId("unsearchable-list")).getAttribute(
        "data-reload-key"
      );
      first.unmount();

      // A later run of its own is new evidence about the same scope.
      mockGet.mockResolvedValue({ job: job({ id: "job-2", status: "succeeded" }) });
      const second = render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} />);
      const afterJob2 = (await screen.findByTestId("unsearchable-list")).getAttribute(
        "data-reload-key"
      );
      expect(afterJob2).not.toBe(afterJob1);

      // So is a changed grant: same run, different scope to report on.
      second.rerender(<KnowledgeReindexSection agentId="a1" allowedPathCount={3} />);
      expect(screen.getByTestId("unsearchable-list").getAttribute("data-reload-key")).not.toBe(
        afterJob2
      );
    });
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
    // The optimistic pending job is a React commit queued by the POST's
    // continuation. `waitFor` would poll for it against a 1000ms WALL-CLOCK
    // budget, which one blocked event-loop turn under a full parallel run
    // consumes entirely. Draining forces the pending work to settle first, so
    // the assertion is both deterministic and stricter: the run must be live
    // the moment the click settles.
    await flushPendingRenders();
    expect(screen.getByRole("button", { name: /reindexing/i })).toBeDisabled();

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

  // Elapsed-time readout: an honest "it's still moving" signal for a long index.
  // It is MEASURED, which is what keeps it here beside the projected estimate
  // below (#907) rather than being replaced by it — the estimate is allowed to
  // be absent, and a run must still show it is alive when it is.
  describe("elapsed time while a run is in flight", () => {
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
    afterEach(() => vi.useRealTimers());

    it("shows how long the running index has been going", async () => {
      // startedAt is 10:00:01; freeze now 12 minutes later.
      vi.setSystemTime(new Date("2026-07-21T10:12:01.000Z"));
      mockGet.mockResolvedValue({
        job: job({ status: "running", processed: 5, total: 20 }),
      });

      render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} />);

      await waitFor(() => expect(screen.getByText(/running 12 min/i)).toBeInTheDocument());
      // Still shows the document progress alongside it.
      expect(screen.getByText(/5 of 20/i)).toBeInTheDocument();
    });

    it("shows elapsed time during the indeterminate discovery phase too", async () => {
      vi.setSystemTime(new Date("2026-07-21T10:00:44.000Z")); // 43s after startedAt
      mockGet.mockResolvedValue({
        job: job({ status: "running", processed: 0, total: null }),
      });

      render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} />);

      // The two halves of this assertion land in DIFFERENT commits: the status
      // read renders "Discovering documents…" while `now` is still null, and
      // only the effect that starts the elapsed clock appends the " · running
      // 43 sec" suffix. Gating on the phase text is therefore the flake shape
      // flushPendingRenders documents — and it did flake exactly so, failing on
      // the elapsed line in a full parallel run while an isolated rerun stayed
      // green. Draining both commits asserts the readout on settled output.
      await flushPendingRenders();
      expect(screen.getByText(/discovering documents/i)).toBeInTheDocument();
      expect(screen.getByText(/running 43 sec/i)).toBeInTheDocument();
    });

    it("omits the elapsed readout when the worker has not started the job yet", async () => {
      vi.setSystemTime(new Date("2026-07-21T10:12:01.000Z"));
      mockGet.mockResolvedValue({
        job: job({ status: "running", processed: 0, total: null, startedAt: null }),
      });

      render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} />);

      await waitFor(() => expect(screen.getByText(/discovering documents/i)).toBeInTheDocument());
      expect(screen.queryByText(/running/i)).not.toBeInTheDocument();
    });

    it("ticks the readout forward on its own as wall-clock time passes", async () => {
      // The whole point of the 1s clock (vs. computing only on each 3s poll) is
      // that the age keeps moving between polls. Freeze at 12 min, then let a
      // minute of wall clock elapse WITHOUT a new poll response and assert the
      // readout advanced itself to 13 min.
      vi.setSystemTime(new Date("2026-07-21T10:12:01.000Z"));
      mockGet.mockResolvedValue({
        job: job({ status: "running", processed: 5, total: 20 }),
      });

      render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} />);

      await waitFor(() => expect(screen.getByText(/running 12 min/i)).toBeInTheDocument());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(screen.getByText(/running 13 min/i)).toBeInTheDocument();
    });
  });

  // #907. Documents are not equal units of work — one compilation PDF was 38%
  // of a 193-document corpus's chunks — so the bar is driven by the corpus's
  // bytes, which discovery knows in full before the first extract.
  describe("byte-weighted progress", () => {
    it("drives the progress bar off the corpus's bytes, not its document count", async () => {
      mockGet.mockResolvedValue({
        job: job({
          status: "running",
          processed: 12,
          total: 193,
          processedBytes: 500_000,
          totalBytes: 1_000_000,
        }),
      });

      render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} />);

      const bar = await screen.findByRole("progressbar");
      // 12 of 193 documents is 6%; half the corpus's bytes are behind the run.
      await waitFor(() => expect(bar).toHaveAttribute("aria-valuenow", "50"));
      // The document counters stay in the label — they answer a different,
      // still useful question.
      expect(screen.getByText(/12 of 193/i)).toBeInTheDocument();
    });

    it("falls back to the document count while the byte total is unknown", async () => {
      mockGet.mockResolvedValue({
        job: job({ status: "running", processed: 5, total: 10, totalBytes: null }),
      });

      render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} />);

      const bar = await screen.findByRole("progressbar");
      await waitFor(() => expect(bar).toHaveAttribute("aria-valuenow", "50"));
    });

    it("clamps a byte reading that overshoots a stale total", async () => {
      mockGet.mockResolvedValue({
        job: job({
          status: "running",
          processed: 3,
          total: 10,
          processedBytes: 1_200_000,
          totalBytes: 1_000_000,
        }),
      });

      render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} />);

      const bar = await screen.findByRole("progressbar");
      await waitFor(() => expect(bar).toHaveAttribute("aria-valuenow", "100"));
    });
  });

  describe("time-to-completion estimate", () => {
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
    afterEach(() => vi.useRealTimers());

    /**
     * Answers every poll with a FRESH job object, the way the real api-client
     * does (it parses JSON per response). Returning one shared object instead
     * makes React bail out of the state update entirely, so the sample series
     * never grows and every absence assertion below passes for the wrong
     * reason — which is exactly how the first draft of these tests was green.
     */
    const alwaysRunningAt = (processedBytes: number, processed: number) =>
      mockGet.mockImplementation(async () => ({
        job: job({
          status: "running",
          processed,
          total: 10,
          processedBytes,
          totalBytes: 1_000_000,
        }),
      }));

    /**
     * Advances the fake clock in poll-sized steps, letting React commit between
     * them. ONE long advance instead collapses all 90 status reads into a
     * single batched render, so the sample series never grows past its mount
     * reading — and a stalled run then looks indistinguishable from a run with
     * no readings at all, quietly passing every absence assertion here.
     */
    const tick = async (seconds: number) => {
      for (let elapsed = 0; elapsed < seconds; elapsed += 5) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5_000);
        });
      }
    };

    it("projects the remaining time from the observed byte rate", async () => {
      vi.setSystemTime(new Date("2026-07-21T10:00:01.000Z"));
      alwaysRunningAt(100_000, 1);

      render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} pollIntervalMs={1000} />);
      await waitFor(() => expect(screen.getByText(/indexing 1 of 10/i)).toBeInTheDocument());

      // 100 kB over the next 20 s = 5 kB/s, and 800 kB are left ≈ 160 s.
      alwaysRunningAt(200_000, 2);
      await tick(20);

      expect(screen.getByText(/~3 min left/)).toBeInTheDocument();
      // Beside the elapsed readout, not instead of it: one is measured, the
      // other projected, and an operator needs to tell them apart.
      expect(screen.getByText(/running \d+ sec/)).toBeInTheDocument();
    });

    // An estimate off two readings a second apart is noise wearing a number's
    // clothes — and the whole reason the elapsed-only readout shipped first is
    // that a number nobody can trust is worse than no number.
    it("says nothing until the readings support an estimate", async () => {
      vi.setSystemTime(new Date("2026-07-21T10:00:01.000Z"));
      alwaysRunningAt(100_000, 1);

      render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} pollIntervalMs={1000} />);
      await waitFor(() => expect(screen.getByText(/indexing 1 of 10/i)).toBeInTheDocument());

      alwaysRunningAt(200_000, 2);
      await tick(5);

      expect(screen.queryByText(/left/i)).not.toBeInTheDocument();
      expect(screen.getByText(/running \d+ sec/)).toBeInTheDocument();
    });

    // A run wedged on one document has no rate to divide by. "∞ min left" and a
    // countdown frozen at "~1 min left" are both lies; silence is not.
    it("withdraws the estimate when the run stops making measurable progress", async () => {
      vi.setSystemTime(new Date("2026-07-21T10:00:01.000Z"));
      alwaysRunningAt(100_000, 1);

      render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} pollIntervalMs={1000} />);
      await waitFor(() => expect(screen.getByText(/indexing 1 of 10/i)).toBeInTheDocument());

      await tick(90);

      expect(screen.queryByText(/left/i)).not.toBeInTheDocument();
      // Still visibly alive: the elapsed readout is what says "not dead".
      expect(screen.getByText(/running 1 min/)).toBeInTheDocument();
    });

    it("offers no estimate during the indeterminate discovery phase", async () => {
      vi.setSystemTime(new Date("2026-07-21T10:00:01.000Z"));
      mockGet.mockImplementation(async () => ({
        job: job({ status: "running", processed: 0, total: null, totalBytes: null }),
      }));

      render(<KnowledgeReindexSection agentId="a1" allowedPathCount={2} pollIntervalMs={1000} />);
      await waitFor(() => expect(screen.getByText(/discovering documents/i)).toBeInTheDocument());

      await tick(30);

      expect(screen.queryByText(/left/i)).not.toBeInTheDocument();
    });
  });

  describe("formatElapsed", () => {
    const base = Date.parse("2026-07-21T10:00:00.000Z");

    it("shows whole seconds under a minute", () => {
      expect(formatElapsed(base, base + 42_000)).toBe("42 sec");
    });

    it("shows whole minutes under an hour, flooring the seconds", () => {
      expect(formatElapsed(base, base + 12 * 60_000 + 30_000)).toBe("12 min");
    });

    it("shows hours and minutes past an hour", () => {
      expect(formatElapsed(base, base + (2 * 60 + 5) * 60_000)).toBe("2 h 5 min");
    });

    it("drops the minutes at an exact hour boundary", () => {
      expect(formatElapsed(base, base + 3 * 3_600_000)).toBe("3 h");
    });

    it("clamps clock skew (now before start) to zero", () => {
      expect(formatElapsed(base, base - 5_000)).toBe("0 sec");
    });

    // An unparseable startedAt yields NaN from Date#getTime, and NaN survives
    // both Math.max and Math.floor — so without a guard the UI would render
    // "NaN h NaN min". Degrade to "0 sec", matching how formatWhen already
    // guards its own NaN date.
    it("degrades to zero rather than NaN on an unparseable timestamp", () => {
      expect(formatElapsed(NaN, base)).toBe("0 sec");
      expect(formatElapsed(base, NaN)).toBe("0 sec");
    });
  });
});
