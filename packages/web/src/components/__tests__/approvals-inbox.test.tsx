// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const fetchPendingApprovals = vi.fn();
const submitApprovalDecision = vi.fn();
vi.mock("@/lib/approvals/client", () => ({
  fetchPendingApprovals: () => fetchPendingApprovals(),
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
    expect(screen.getByText(/recordId: 5/)).toBeInTheDocument();
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
