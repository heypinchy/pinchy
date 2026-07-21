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
    submitApprovalDecision.mockResolvedValue(undefined);
    render(<ApprovalsInbox />);
    await screen.findByText(/needs your confirmation/i);

    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() =>
      expect(submitApprovalDecision).toHaveBeenCalledWith("req-1", { decision: "approve" })
    );
    await waitFor(() => expect(screen.queryByText(/needs your confirmation/i)).toBeNull());
  });

  it("denies a request", async () => {
    fetchPendingApprovals.mockResolvedValue({ approvals: [pending] });
    submitApprovalDecision.mockResolvedValue(undefined);
    render(<ApprovalsInbox />);
    await screen.findByText(/needs your confirmation/i);

    fireEvent.click(screen.getByRole("button", { name: /deny/i }));
    await waitFor(() =>
      expect(submitApprovalDecision).toHaveBeenCalledWith("req-1", { decision: "deny" })
    );
  });
});
