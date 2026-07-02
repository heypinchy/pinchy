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

// The thread's inline-error signal (#583). Default false so the banner renders
// as before; the suppression test flips it to true.
let mockHasInlineError = false;
vi.mock("@/components/chat-session-provider", () => ({
  useChatSessionHasInlineError: () => mockHasInlineError,
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

// A durable provider-rejection: OpenClaw's generic catch-all, classified
// `unknown`, carrying the server-computed admin hint (#584).
const providerRejectionRow = {
  id: "err-2",
  agentName: "Smithers",
  model: null,
  errorClass: "unknown",
  transientReason: null,
  providerError: "LLM request failed: provider rejected the request schema or tool payload.",
  sideEffects: false,
  clientMessageId: "cm-2",
  createdAt: "2026-06-24T09:21:00Z",
  hint: "Go to Settings > AI Provider to check your API configuration.",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockHasInlineError = false;
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

  it("surfaces the server hint for a durable provider-rejection (#584)", async () => {
    // Without a hint the banner shows the bare "...schema or tool payload"
    // wording, which reads like a malformed-request bug. The server-computed
    // admin hint must render the actionable "Settings > AI Provider" link.
    mockApiGet.mockResolvedValue({ error: providerRejectionRow });
    render(<ChatErrorBanner agentId="agent-1" onRetry={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("Smithers couldn't respond")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /settings > ai provider/i })).toBeInTheDocument();
  });

  it("suppresses itself when the thread already shows the inline error for this run (#583)", async () => {
    // The banner is a fallback for an error the live bubble LOST to reload/
    // reconnect. When the runtime bundle survives a nav-away/back, the inline
    // turn-failure bubble is still on screen — rendering the banner too would
    // duplicate the same failure. With the thread's inline error present, the
    // banner renders nothing even though an active error exists server-side.
    mockHasInlineError = true;
    mockApiGet.mockResolvedValue({ error: transientRow });
    const { container } = render(<ChatErrorBanner agentId="agent-1" onRetry={vi.fn()} />);

    // Give the mount fetch a chance to resolve; the banner must still be empty.
    await waitFor(() => expect(mockApiGet).toHaveBeenCalled());
    expect(screen.queryByText("Penny paused")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
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
