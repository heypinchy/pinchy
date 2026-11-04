// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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
import { ARM_MS } from "../approval-card";
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
    fireEvent.click(screen.getByRole("button", { name: /review/i }));
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

  /**
   * Every test above renders ONE surface and reads the filter it applies. That
   * is each half's own account of itself, and the invariant is about the pair:
   * in the running app both are mounted at once, and a card must appear exactly
   * once — never twice, never nowhere. Same lesson as the X-Frame-Options gate:
   * assert what the mounted app renders, not what a component asked for.
   *
   * It is also the only test that can fail if the two ever stop sharing one
   * poller: two of them drift for up to a poll interval, which is exactly long
   * enough to render the same confirmation in both places.
   */
  describe("both surfaces mounted, as the app mounts them", () => {
    function bothSurfaces(openAgentId: string | null) {
      return render(
        <>
          <AgentIdContext.Provider value={openAgentId}>
            <ThreadApprovals />
          </AgentIdContext.Provider>
          <ApprovalsInbox />
        </>
      );
    }

    it("shows the open agent's confirmation exactly once", async () => {
      fetchPendingApprovals.mockResolvedValue({ approvals: [approval()] });

      bothSurfaces("a1");

      await screen.findByText(/needs your confirmation/i);
      expect(screen.getAllByText(/needs your confirmation/i)).toHaveLength(1);
    });

    it("shows another agent's confirmation exactly once", async () => {
      fetchPendingApprovals.mockResolvedValue({ approvals: [approval({ agentId: "other" })] });

      bothSurfaces("a1");

      await screen.findByText(/needs your confirmation/i);
      expect(screen.getAllByText(/needs your confirmation/i)).toHaveLength(1);
    });

    it("shows one card per confirmation when both agents are waiting", async () => {
      fetchPendingApprovals.mockResolvedValue({
        approvals: [approval(), approval({ id: "req-2", agentId: "other", agentName: "Odoo" })],
      });

      bothSurfaces("a1");

      await screen.findByText(/Odoo needs your confirmation/i);
      expect(screen.getAllByText(/needs your confirmation/i)).toHaveLength(2);
    });

    // The thread and the corner are one screen: between them they draw one
    // card's arguments and decision at a time, never one per surface.
    it("opens one card across both surfaces", async () => {
      fetchPendingApprovals.mockResolvedValue({
        approvals: [
          approval(),
          approval({ id: "req-2", agentId: "other", agentName: "Odoo", argsSummary: { x: 1 } }),
        ],
      });

      bothSurfaces("a1");

      await screen.findByText(/Odoo needs your confirmation/i);
      expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: /review .* for Smithers/i }));
      expect(screen.getAllByRole("button", { name: /approve/i })).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: /review/i })).toHaveLength(1);

      fireEvent.click(screen.getByRole("button", { name: /review .* for Odoo/i }));
      expect(screen.getAllByRole("button", { name: /approve/i })).toHaveLength(1);
      expect(screen.getByText("x")).toBeInTheDocument();
      expect(screen.queryByText("recordId")).toBeNull();
    });

    // A newer confirmation in the open thread must not take over from the card
    // the person is reading in the corner: its Approve would land where theirs was.
    it("keeps the corner card open when a newer confirmation arrives in the thread", async () => {
      const corner = approval({
        id: "req-2",
        agentId: "other",
        agentName: "Odoo",
        argsSummary: { x: 1 },
      });
      fetchPendingApprovals.mockResolvedValue({ approvals: [corner] });

      bothSurfaces("a1");

      await screen.findByText(/Odoo needs your confirmation/i);
      fireEvent.click(screen.getByRole("button", { name: /review/i }));
      const approve = screen.getByRole("button", { name: /approve/i });

      fetchPendingApprovals.mockResolvedValue({ approvals: [approval(), corner] });
      document.dispatchEvent(new Event("visibilitychange"));
      await screen.findByText(/Smithers needs your confirmation/i);

      expect(screen.getByRole("button", { name: /approve/i })).toBe(approve);
      expect(screen.getByText("x")).toBeInTheDocument();
      const thread = screen
        .getAllByRole("region", { name: /pending approvals/i })
        .find((region) => within(region).queryByText(/Smithers/));
      expect(within(thread!).getByRole("button", { name: /review/i })).toBeInTheDocument();
    });
  });

  // The thread is anchored to its top, so a card arriving above the open one
  // pushes it down by one card height — its Approve onto the pixels where the
  // card below it had its Review, under the pointer about to click it.
  it("does not approve with a click aimed at a card below when a card arrives above", async () => {
    const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element
    ) {
      const card = this.closest("[role=region] > *");
      let above = 0;
      for (let prev = card?.previousElementSibling; prev; prev = prev.previousElementSibling)
        above++;
      return new DOMRect(0, 100 + 100 * above, 80, 32);
    });
    try {
      const open = approval();
      const below = approval({ id: "req-3", argsSummary: { y: 2 } });
      const newer = approval({ id: "req-2", argsSummary: { x: 1 } });
      fetchPendingApprovals.mockResolvedValue({ approvals: [open, below] });
      submitApprovalDecision.mockResolvedValue({ ok: true, status: "approved", resumed: true });
      render(
        <AgentIdContext.Provider value="a1">
          <ThreadApprovals />
        </AgentIdContext.Provider>
      );
      await screen.findAllByText(/needs your confirmation/i);
      fireEvent.click(screen.getAllByRole("button", { name: /review/i })[0]);
      const approve = screen.getByRole("button", { name: /approve/i });
      await waitFor(() => expect(approve).not.toHaveAttribute("aria-disabled", "true"), {
        timeout: ARM_MS + 1000,
      });

      fetchPendingApprovals.mockResolvedValue({ approvals: [newer, open, below] });
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(screen.getAllByText(/needs your confirmation/i)).toHaveLength(3));
      fireEvent.click(approve);
      expect(submitApprovalDecision).not.toHaveBeenCalled();

      await waitFor(() => expect(approve).not.toHaveAttribute("aria-disabled", "true"), {
        timeout: ARM_MS + 1000,
      });
      fireEvent.click(approve);
      await waitFor(() =>
        expect(submitApprovalDecision).toHaveBeenCalledWith("req-1", { decision: "approve" })
      );
    } finally {
      spy.mockRestore();
    }
  });
});
