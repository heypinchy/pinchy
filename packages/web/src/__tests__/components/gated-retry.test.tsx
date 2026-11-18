// @vitest-environment jsdom
// The retry gate as the user meets it: a question asked when Retry is pressed,
// not when the run failed (#1013).
//
// The failure frame's own `sideEffects` is provisional — OpenClaw fires
// `after_tool_call` without awaiting it, so the audit row proving the agent
// acted may not have landed when the flag was computed. A `false` there is not
// evidence of a read-only run, which is why this component asks again.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { GatedRetry } from "@/components/chat/gated-retry";

const mockApiGet = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiGet: (...args: unknown[]) => mockApiGet(...args),
}));

function renderGate(props: Partial<React.ComponentProps<typeof GatedRetry>> = {}) {
  const onRetry = vi.fn();
  render(
    <GatedRetry
      agentId="agent-1"
      agentName="Penny"
      sideEffects={false}
      onRetry={onRetry}
      {...props}
    >
      {(start) => (
        <button type="button" onClick={start}>
          Retry
        </button>
      )}
    </GatedRetry>
  );
  return { onRetry, click: () => userEvent.click(screen.getByRole("button", { name: "Retry" })) };
}

const confirmDialog = () => screen.queryByRole("alertdialog");

beforeEach(() => {
  vi.clearAllMocks();
  mockApiGet.mockResolvedValue({ sideEffects: false });
});

describe("GatedRetry", () => {
  it("retries directly when neither the frame nor the server reports a tool call", async () => {
    const { onRetry, click } = renderGate();
    await click();
    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
    expect(confirmDialog()).not.toBeInTheDocument();
  });

  it("warns about duplicates when the server says a tool ran after all", async () => {
    // The bug: the frame said false because the audit row was still in flight.
    mockApiGet.mockResolvedValue({ sideEffects: true });
    const { onRetry, click } = renderGate();

    await click();

    await waitFor(() => expect(confirmDialog()).toBeInTheDocument());
    expect(screen.getByText(/may create duplicates/i)).toBeInTheDocument();
    // Crucially NOT retried behind the user's back while we asked.
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("runs the retry once the user confirms", async () => {
    mockApiGet.mockResolvedValue({ sideEffects: true });
    const { onRetry, click } = renderGate();
    await click();
    await waitFor(() => expect(confirmDialog()).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /retry anyway/i }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the user cancels", async () => {
    mockApiGet.mockResolvedValue({ sideEffects: true });
    const { onRetry, click } = renderGate();
    await click();
    await waitFor(() => expect(confirmDialog()).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(confirmDialog()).not.toBeInTheDocument());
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("skips the round trip when the failure already reported a tool call", async () => {
    // Already-true needs no confirmation from the server: the gate is monotonic,
    // and a user staring at a warned failure should not wait on a fetch.
    const { onRetry, click } = renderGate({ sideEffects: true });

    await click();

    await waitFor(() => expect(confirmDialog()).toBeInTheDocument());
    expect(mockApiGet).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("warns rather than proceeding when the gate cannot be checked", async () => {
    // Fail closed. The cost of a needless confirm is one click; the cost of a
    // missing one is a duplicated booking.
    mockApiGet.mockRejectedValue(new Error("offline"));
    const { onRetry, click } = renderGate();

    await click();

    await waitFor(() => expect(confirmDialog()).toBeInTheDocument());
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("asks about the chat the user is looking at", async () => {
    const { click } = renderGate({ chatId: "chat 7" });
    await click();
    await waitFor(() =>
      expect(mockApiGet).toHaveBeenCalledWith("/api/agents/agent-1/retry-gate?chatId=chat%207")
    );
  });

  it("addresses the default session when there is no chatId", async () => {
    const { click } = renderGate();
    await click();
    await waitFor(() => expect(mockApiGet).toHaveBeenCalledWith("/api/agents/agent-1/retry-gate"));
  });

  it("retries without asking when there is no agent to ask about", async () => {
    // Defensive: a missing agentId is a context wiring bug, not a signal that
    // the run wrote something. Blocking every retry behind a confirm there
    // would teach users to click through the one that matters.
    const { onRetry, click } = renderGate({ agentId: undefined });
    await click();
    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
    expect(mockApiGet).not.toHaveBeenCalled();
  });

  it("ignores repeat clicks while the check is in flight", async () => {
    let resolve!: (v: { sideEffects: boolean }) => void;
    mockApiGet.mockReturnValue(new Promise((r) => (resolve = r)));
    const { onRetry, click } = renderGate();

    await click();
    await click();
    await click();
    resolve({ sideEffects: false });

    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
    expect(mockApiGet).toHaveBeenCalledTimes(1);
  });
});
