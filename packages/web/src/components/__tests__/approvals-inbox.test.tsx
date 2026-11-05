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
import { ARM_MS } from "../approval-card";

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

/**
 * Opens a card the way the person does — with its Review button — and waits
 * until its decision is offered.
 */
async function review(index = 0) {
  fireEvent.click(screen.getAllByRole("button", { name: /review/i }).at(index)!);
  const approve = screen.getByRole("button", { name: /approve/i });
  await waitFor(() => expect(approve).not.toHaveAttribute("aria-disabled", "true"), {
    timeout: ARM_MS + 1000,
  });
  return approve;
}

/**
 * Draws the corner as the browser does: the stack is anchored to the bottom,
 * so a card sits one card height higher for every card below it.
 */
function bottomAnchoredStack() {
  const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element
  ) {
    const card = this.closest("[role=region] > *");
    let below = 0;
    for (let next = card?.nextElementSibling; next; next = next.nextElementSibling) below++;
    return new DOMRect(0, 700 - 100 * below, 80, 32);
  });
  return () => spy.mockRestore();
}

describe("ApprovalsInbox", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders nothing when there are no pending approvals", async () => {
    fetchPendingApprovals.mockResolvedValue({ approvals: [] });
    const { container } = render(<ApprovalsInbox />);
    await waitFor(() => expect(fetchPendingApprovals).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a pending card with the tool, and its summary once asked to", async () => {
    fetchPendingApprovals.mockResolvedValue({ approvals: [pending] });
    render(<ApprovalsInbox />);
    await screen.findByText(/Smithers needs your confirmation/i);
    expect(screen.getByText(/Change records in Odoo/)).toBeInTheDocument();
    expect(screen.queryByText("Record ID")).toBeNull();
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();

    await review();
    expect(screen.getByText("Record ID")).toBeInTheDocument();
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
    await screen.findByText(/needs your confirmation/i);
    fireEvent.click(screen.getByRole("button", { name: /review/i }));
    expect(screen.getByText("Record ID")).toBeInTheDocument();
    expect(fetchPendingApprovals).toHaveBeenLastCalledWith([]);

    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(fetchPendingApprovals).toHaveBeenLastCalledWith(["req-1"]));
    await waitFor(() => expect(fetchPendingApprovals).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Record ID")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  // A card listed without its summary that the poller does not hold — the server
  // read it as known, but the snapshot has since dropped it — must wait for the
  // next poll. Rendered with `argsSummary: null` it would be an approvable card
  // that shows nothing of what it approves.
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
    await screen.findByText(/needs your confirmation/i);
    fireEvent.click(screen.getByRole("button", { name: /review/i }));
    expect(screen.getByText("Record ID")).toBeInTheDocument();
  });

  // Rendered with `argsSummary: null`, a card would be approvable while showing
  // none of its arguments. The route leaves out a card settled between its two
  // reads; the poller also treats a `null` it does not already hold as "no
  // summary yet", so no other path can bring such an empty card up.
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
    await screen.findByText(/needs your confirmation/i);
    fireEvent.click(screen.getByRole("button", { name: /review/i }));
    expect(screen.getByText("Record ID")).toBeInTheDocument();
  });

  it("approves a request and removes it from the list", async () => {
    fetchPendingApprovals.mockResolvedValue({ approvals: [pending] });
    submitApprovalDecision.mockResolvedValue({ ok: true, status: "approved", resumed: true });
    render(<ApprovalsInbox />);
    await screen.findByText(/needs your confirmation/i);

    fireEvent.click(await review());
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

    fireEvent.click(await review());

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

    fireEvent.click(await review());

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

  // One card's body is bounded (DRAW_BUDGET), but a person may have many
  // cards waiting, and drawn all at once twenty at that bound took Chromium
  // 1.8 s and WebKit 3.7 s. So the screen draws one card's arguments and its
  // Approve/Deny at a time; every other card is a line naming the agent and
  // the tool, with a button to review it.
  //
  // Which card is open is the person's choice alone. A card that opened by
  // itself — the newest, or the next once one is decided — would put its
  // Approve on the pixels where the person was about to click another card's.
  describe("with many confirmations waiting", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      ...pending,
      id: `req-${i}`,
      agentId: `agent-${i}`,
      agentName: `Agent ${i}`,
      argsSummary: { [`field${i}`]: `value ${i}` },
    }));
    const [newer, older] = many;

    /** The next poll answers with `approvals`. */
    async function poll(approvals: typeof many) {
      const calls = fetchPendingApprovals.mock.calls.length;
      fetchPendingApprovals.mockResolvedValue({ approvals });
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(fetchPendingApprovals).toHaveBeenCalledTimes(calls + 1));
    }

    it("opens no card by itself", async () => {
      fetchPendingApprovals.mockResolvedValue({ approvals: many });
      render(<ApprovalsInbox />);
      await screen.findByText(/Agent 0 needs your confirmation/i);

      expect(screen.getAllByText(/needs your confirmation/i)).toHaveLength(20);
      for (let i = 0; i < 20; i++) expect(screen.queryByText(`Field${i}`)).toBeNull();
      expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
      expect(screen.getAllByRole("button", { name: /review/i })).toHaveLength(20);
    });

    it("draws the arguments and the decision of one card at a time", async () => {
      fetchPendingApprovals.mockResolvedValue({ approvals: many });
      render(<ApprovalsInbox />);
      await screen.findByText(/Agent 0 needs your confirmation/i);
      await review(0);

      expect(screen.getByText("Field0")).toBeInTheDocument();
      for (let i = 1; i < 20; i++) expect(screen.queryByText(`Field${i}`)).toBeNull();
      expect(screen.getAllByRole("button", { name: /approve/i })).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: /deny/i })).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: /review/i })).toHaveLength(19);
    });

    it("opens the card asked for, and closes the one that was open", async () => {
      fetchPendingApprovals.mockResolvedValue({ approvals: many });
      submitApprovalDecision.mockResolvedValue({ ok: true, status: "approved", resumed: true });
      render(<ApprovalsInbox />);
      await screen.findByText(/Agent 0 needs your confirmation/i);
      await review(0);

      const approve = await review(4);
      expect(screen.getByText("Field5")).toBeInTheDocument();
      expect(screen.queryByText("Field0")).toBeNull();
      expect(screen.getAllByRole("button", { name: /approve/i })).toHaveLength(1);

      fireEvent.click(approve);
      await waitFor(() =>
        expect(submitApprovalDecision).toHaveBeenCalledWith("req-5", { decision: "approve" })
      );
    });

    it("keeps the open card open when a newer confirmation arrives", async () => {
      fetchPendingApprovals.mockResolvedValue({ approvals: [older] });
      submitApprovalDecision.mockResolvedValue({ ok: true, status: "approved", resumed: true });
      render(<ApprovalsInbox />);
      await screen.findByText(/Agent 1 needs your confirmation/i);
      const approve = await review();

      await poll([newer, older]);
      await screen.findByText(/Agent 0 needs your confirmation/i);
      expect(screen.getByText("Field1")).toBeInTheDocument();
      expect(screen.queryByText("Field0")).toBeNull();
      expect(screen.getByRole("button", { name: /approve/i })).toBe(approve);
      expect(screen.getAllByRole("button", { name: /review/i })).toHaveLength(1);

      fireEvent.click(approve);
      await waitFor(() =>
        expect(submitApprovalDecision).toHaveBeenCalledWith("req-1", { decision: "approve" })
      );
      expect(submitApprovalDecision).toHaveBeenCalledTimes(1);
    });

    it("opens nothing once the open card is decided, and hands focus to the next card's Review", async () => {
      fetchPendingApprovals.mockResolvedValue({ approvals: many });
      submitApprovalDecision.mockResolvedValue({ ok: true, status: "denied", resumed: true });
      render(<ApprovalsInbox />);
      await screen.findByText(/Agent 0 needs your confirmation/i);
      await review(0);

      const deny = screen.getByRole("button", { name: /deny/i });
      deny.focus();
      fireEvent.click(deny);
      await waitFor(() => expect(screen.queryByText(/Agent 0 needs/i)).toBeNull());

      expect(screen.queryByText("Field1")).toBeNull();
      expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
      const reviews = screen.getAllByRole("button", { name: /review/i });
      expect(reviews).toHaveLength(19);
      await waitFor(() => expect(document.activeElement).toBe(reviews[0]));
    });

    // C below the open card leaves — it expired, or was answered in another
    // tab — and the open card drops into its place: its Approve now sits where
    // C's Review was, under the pointer that was about to click it.
    it("does not approve with a click aimed at a card below that has just left", async () => {
      const restore = bottomAnchoredStack();
      try {
        fetchPendingApprovals.mockResolvedValue({ approvals: [newer, older] });
        submitApprovalDecision.mockResolvedValue({ ok: true, status: "approved", resumed: true });
        render(<ApprovalsInbox />);
        await screen.findByText(/Agent 1 needs your confirmation/i);
        const approve = await review(0);

        await poll([newer]);
        await waitFor(() => expect(screen.queryByText(/Agent 1 needs/i)).toBeNull());
        fireEvent.click(approve);
        expect(submitApprovalDecision).not.toHaveBeenCalled();

        await waitFor(() => expect(approve).not.toHaveAttribute("aria-disabled", "true"), {
          timeout: ARM_MS + 1000,
        });
        fireEvent.click(approve);
        await waitFor(() =>
          expect(submitApprovalDecision).toHaveBeenCalledWith("req-0", { decision: "approve" })
        );
      } finally {
        restore();
      }
    });

    it("opens nothing when the open card is decided elsewhere", async () => {
      fetchPendingApprovals.mockResolvedValue({ approvals: [newer, older] });
      render(<ApprovalsInbox />);
      await screen.findByText(/Agent 1 needs your confirmation/i);
      await review(1);

      await poll([newer]);
      await waitFor(() => expect(screen.queryByText(/Agent 1 needs/i)).toBeNull());
      expect(screen.queryByText("Field0")).toBeNull();
      expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
      expect(screen.getAllByRole("button", { name: /review/i })).toHaveLength(1);
    });
  });

  it("denies a request", async () => {
    fetchPendingApprovals.mockResolvedValue({ approvals: [pending] });
    submitApprovalDecision.mockResolvedValue({ ok: true, status: "denied", resumed: true });
    render(<ApprovalsInbox />);
    await screen.findByText(/needs your confirmation/i);
    await review();

    fireEvent.click(screen.getByRole("button", { name: /deny/i }));
    await waitFor(() =>
      expect(submitApprovalDecision).toHaveBeenCalledWith("req-1", { decision: "deny" })
    );
  });
});
