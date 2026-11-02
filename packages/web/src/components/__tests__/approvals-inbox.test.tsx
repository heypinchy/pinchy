// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const fetchPendingApprovals = vi.fn();
const submitApprovalDecision = vi.fn();
vi.mock("@/lib/approvals/client", () => ({
  fetchPendingApprovals: (...args: unknown[]) => fetchPendingApprovals(...args),
  submitApprovalDecision: (id: string, body: unknown) => submitApprovalDecision(id, body),
}));

import { ApprovalsInbox } from "../approvals-inbox";

const pending = {
  id: "req-1",
  agentId: "a1",
  agentName: "Smithers",
  toolName: "odoo_write",
  argsSummary: { recordId: 5 },
  sessionKey: "agent:a1:direct:u",
  createdAt: "",
  expiresAt: "",
};

describe("ApprovalsInbox", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders nothing when there are no pending approvals", async () => {
    fetchPendingApprovals.mockResolvedValue({ approvals: [] });
    const { container } = render(<ApprovalsInbox />);
    await waitFor(() => expect(fetchPendingApprovals).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a pending card with the tool and a summary", async () => {
    fetchPendingApprovals.mockResolvedValue({ approvals: [pending] });
    render(<ApprovalsInbox />);
    await screen.findByText(/Smithers needs your confirmation/i);
    expect(screen.getByText(/odoo_write/)).toBeInTheDocument();
    expect(screen.getByText("recordId")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  // A summary may be 0.5–1.5 MB (a long report written to a file), and
  // the list is polled every five seconds for as long as the card waits. It
  // never changes once stored, so each poll names the cards it already holds
  // and the server sends those back without their summary.
  it("sends each summary once: later polls name the cards they hold and keep the summary", async () => {
    fetchPendingApprovals.mockResolvedValueOnce({ approvals: [pending] });
    const { argsSummary: _held, ...withoutSummary } = pending;
    fetchPendingApprovals.mockResolvedValue({ approvals: [withoutSummary] });
    render(<ApprovalsInbox />);
    await screen.findByText("recordId");
    expect(fetchPendingApprovals).toHaveBeenLastCalledWith([]);

    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(fetchPendingApprovals).toHaveBeenLastCalledWith(["req-1"]));
    await waitFor(() => expect(fetchPendingApprovals).toHaveBeenCalledTimes(2));
    expect(screen.getByText("recordId")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  // Fifth review of #1242: a card listed without its summary that the poller
  // does not hold — the server read it as known, but the snapshot has since
  // dropped it — must wait for the next poll. Rendered with `argsSummary: null`
  // it would be an approvable card that shows nothing of what it approves.
  it("does not render a card whose summary it neither received nor holds", async () => {
    const { argsSummary: _held, ...withoutSummary } = pending;
    fetchPendingApprovals.mockResolvedValueOnce({ approvals: [withoutSummary] });
    fetchPendingApprovals.mockResolvedValue({ approvals: [pending] });
    render(<ApprovalsInbox />);
    await waitFor(() => expect(fetchPendingApprovals).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(screen.queryByText(/needs your confirmation/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();

    // The next poll does not name it as held, so it gets the summary back.
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(fetchPendingApprovals).toHaveBeenCalledTimes(2));
    expect(fetchPendingApprovals).toHaveBeenLastCalledWith([]);
    await screen.findByText("recordId");
  });

  // Sixth review of #1242: a card settled between the route's two reads came
  // back with `argsSummary: null`, and the poller rendered it — an approvable
  // card showing none of the arguments. The route now leaves such a card out;
  // the poller also treats a `null` it does not already hold as "no summary
  // yet", so no other path can bring the empty card back.
  it("does not render a card that arrives with a null summary it does not hold", async () => {
    fetchPendingApprovals.mockResolvedValueOnce({ approvals: [{ ...pending, argsSummary: null }] });
    fetchPendingApprovals.mockResolvedValue({ approvals: [pending] });
    render(<ApprovalsInbox />);
    await waitFor(() => expect(fetchPendingApprovals).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(screen.queryByText(/needs your confirmation/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();

    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(fetchPendingApprovals).toHaveBeenCalledTimes(2));
    expect(fetchPendingApprovals).toHaveBeenLastCalledWith([]);
    await screen.findByText("recordId");
  });

  it("approves a request and removes it from the list", async () => {
    fetchPendingApprovals.mockResolvedValue({ approvals: [pending] });
    submitApprovalDecision.mockResolvedValue({ ok: true, status: "approved", resumed: true });
    render(<ApprovalsInbox />);
    await screen.findByText(/needs your confirmation/i);

    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() =>
      expect(submitApprovalDecision).toHaveBeenCalledWith("req-1", { decision: "approve" })
    );
    await waitFor(() => expect(screen.queryByText(/needs your confirmation/i)).toBeNull());
  });

  // #1132. The run is parked inside OpenClaw and resumes on its own once the
  // decision reaches it — so the old "ask Smithers to proceed" was an
  // instruction to do something unnecessary, and a user who followed it would
  // send a second turn on top of a call that was already running again.
  it("says the agent is continuing, not that the user has to prompt it", async () => {
    fetchPendingApprovals.mockResolvedValue({ approvals: [pending] });
    submitApprovalDecision.mockResolvedValue({ ok: true, status: "approved", resumed: true });
    render(<ApprovalsInbox />);
    await screen.findByText(/needs your confirmation/i);

    fireEvent.click(screen.getByRole("button", { name: /approve/i }));

    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(vi.mocked(toast.success).mock.calls[0][0]).toMatch(/Smithers/);
    expect(vi.mocked(toast.success).mock.calls[0][0]).not.toMatch(/proceed/i);
  });

  // The decision is persisted but the parked run never heard it, so the tool
  // will NOT run. A success toast here is the exact lie this path exists to
  // avoid: the user walks away believing the invoice got booked.
  it("warns instead of confirming when the decision did not reach the run", async () => {
    fetchPendingApprovals.mockResolvedValue({ approvals: [pending] });
    submitApprovalDecision.mockResolvedValue({
      ok: true,
      status: "approved",
      resumed: false,
      resumeError: "The agent is no longer waiting for this decision.",
    });
    render(<ApprovalsInbox />);
    await screen.findByText(/needs your confirmation/i);

    fireEvent.click(screen.getByRole("button", { name: /approve/i }));

    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(vi.mocked(toast.error).mock.calls[0][0]).toMatch(/no longer waiting/i);
    expect(toast.success).not.toHaveBeenCalled();
    // The row is settled either way, so the card must not stay clickable —
    // a second click can only 409.
    await waitFor(() => expect(screen.queryByText(/needs your confirmation/i)).toBeNull());
  });

  it("does not poll while the tab is hidden and polls immediately on becoming visible", async () => {
    let visibility: DocumentVisibilityState = "hidden";
    const spy = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    try {
      fetchPendingApprovals.mockResolvedValue({ approvals: [] });
      render(<ApprovalsInbox />);

      // Mounted hidden: the initial poll is skipped entirely.
      await Promise.resolve();
      expect(fetchPendingApprovals).not.toHaveBeenCalled();

      visibility = "visible";
      fireEvent(document, new Event("visibilitychange"));
      await waitFor(() => expect(fetchPendingApprovals).toHaveBeenCalledTimes(1));
    } finally {
      spy.mockRestore();
    }
  });

  it("denies a request", async () => {
    fetchPendingApprovals.mockResolvedValue({ approvals: [pending] });
    submitApprovalDecision.mockResolvedValue({ ok: true, status: "denied", resumed: true });
    render(<ApprovalsInbox />);
    await screen.findByText(/needs your confirmation/i);

    fireEvent.click(screen.getByRole("button", { name: /deny/i }));
    await waitFor(() =>
      expect(submitApprovalDecision).toHaveBeenCalledWith("req-1", { decision: "deny" })
    );
  });
});
