import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ChatErrorBanner } from "@/components/chat-error-banner";

const mockApiGet = vi.fn();
const mockApiDelete = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiGet: (...args: unknown[]) => mockApiGet(...args),
  apiDelete: (...args: unknown[]) => mockApiDelete(...args),
}));

const transientRow = {
  id: "err-1",
  agentName: "Penny",
  model: "ollama-cloud/gemini-3-flash",
  errorClass: "transient",
  transientReason: "rate_limit",
  providerError: "API rate limit reached",
  sideEffects: true,
  clientMessageId: "cm-1",
  createdAt: "2026-06-18T09:38:43Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApiDelete.mockResolvedValue({ dismissed: true });
});

describe("ChatErrorBanner", () => {
  it("renders nothing when the session has no active error", async () => {
    mockApiGet.mockResolvedValue({ error: null });
    const { container } = render(<ChatErrorBanner agentId="agent-1" onRetry={vi.fn()} />);
    await waitFor(() => expect(mockApiGet).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("fetches the active error for the chat (incl. chatId) and shows honest copy", async () => {
    mockApiGet.mockResolvedValue({ error: transientRow });
    render(<ChatErrorBanner agentId="agent-1" chatId="chat-7" onRetry={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("Penny paused")).toBeInTheDocument());
    expect(screen.getByText(/rate-limiting/i)).toBeInTheDocument();
    expect(screen.getByTestId("side-effects-warning")).toBeInTheDocument();
    expect(mockApiGet).toHaveBeenCalledWith("/api/agents/agent-1/active-error?chatId=chat-7");
  });

  it("dismisses via the API and hides the banner", async () => {
    mockApiGet.mockResolvedValue({ error: transientRow });
    render(<ChatErrorBanner agentId="agent-1" onRetry={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Penny paused")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

    await waitFor(() =>
      expect(mockApiDelete).toHaveBeenCalledWith("/api/agents/agent-1/active-error?id=err-1")
    );
    await waitFor(() => expect(screen.queryByText("Penny paused")).not.toBeInTheDocument());
  });

  it("requires confirmation before retrying when the run had side effects", async () => {
    const onRetry = vi.fn();
    mockApiGet.mockResolvedValue({ error: transientRow });
    render(<ChatErrorBanner agentId="agent-1" onRetry={onRetry} />);
    await waitFor(() => expect(screen.getByText("Penny paused")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /^retry$/i }));
    // A confirm step appears because retrying may duplicate writes.
    expect(onRetry).not.toHaveBeenCalled();
    const confirm = await screen.findByRole("button", { name: /retry anyway/i });
    fireEvent.click(confirm);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("retries directly (no confirm) for a read-only run", async () => {
    const onRetry = vi.fn();
    mockApiGet.mockResolvedValue({ error: { ...transientRow, sideEffects: false } });
    render(<ChatErrorBanner agentId="agent-1" onRetry={onRetry} />);
    await waitFor(() => expect(screen.getByText("Penny paused")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /^retry$/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
