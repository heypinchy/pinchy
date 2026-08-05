// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const fetchPendingApprovals = vi.fn();
const submitApprovalDecision = vi.fn();
vi.mock("@/lib/approvals/client", () => ({
  fetchPendingApprovals: () => fetchPendingApprovals(),
  submitApprovalDecision: (id: string, body: unknown) => submitApprovalDecision(id, body),
}));

const mockParams = vi.fn();
vi.mock("next/navigation", () => ({ useParams: () => mockParams() }));

import { ThreadApprovals } from "../thread-approvals";
import { ApprovalsInbox } from "../approvals-inbox";
import { AgentIdContext } from "../chat";

function approval(over: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    agentId: "a1",
    agentName: "Smithers",
    toolName: "odoo_write",
    argsSummary: { recordId: 5 },
    sessionKey: "agent:a1:direct:u",
    createdAt: "",
    expiresAt: "",
    ...over,
  };
}

/**
 * #1132. A confirmation belongs to the conversation that raised it — a card in
 * the bottom-right corner is spatially divorced from the message it is about.
 * The split is: the open agent's confirmation renders in its thread, everything
 * else stays in the corner, so a run parked in another chat is still visible.
 * The pairing matters more than either half: shown in both places is a
 * duplicate, shown in neither is a run that times out unseen.
 */
describe("approval card placement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParams.mockReturnValue({ agentId: "a1" });
  });

  it("renders the open agent's confirmation inside its own thread", async () => {
    fetchPendingApprovals.mockResolvedValue({ approvals: [approval()] });

    render(
      <AgentIdContext.Provider value="a1">
        <ThreadApprovals />
      </AgentIdContext.Provider>
    );

    await screen.findByText(/needs your confirmation/i);
    expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
  });

  it("leaves another agent's confirmation to the corner", async () => {
    fetchPendingApprovals.mockResolvedValue({ approvals: [approval({ agentId: "other" })] });

    const { container } = render(
      <AgentIdContext.Provider value="a1">
        <ThreadApprovals />
      </AgentIdContext.Provider>
    );

    await waitFor(() => expect(fetchPendingApprovals).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps the corner card out of the thread that already shows it", async () => {
    fetchPendingApprovals.mockResolvedValue({ approvals: [approval()] });

    const { container } = render(<ApprovalsInbox />);

    await waitFor(() => expect(fetchPendingApprovals).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("still shows a confirmation raised in a chat the user has left", async () => {
    // The run is parked for at most 10 minutes. Dropping this card because the
    // user switched chats would let it time out with nobody ever seeing it.
    fetchPendingApprovals.mockResolvedValue({ approvals: [approval({ agentId: "other" })] });

    render(<ApprovalsInbox />);

    await screen.findByText(/needs your confirmation/i);
  });

  it("shows every confirmation in the corner when no chat is open", async () => {
    mockParams.mockReturnValue({});
    fetchPendingApprovals.mockResolvedValue({ approvals: [approval()] });

    render(<ApprovalsInbox />);

    await screen.findByText(/needs your confirmation/i);
  });
});
