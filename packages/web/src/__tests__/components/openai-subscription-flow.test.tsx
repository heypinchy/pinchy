import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OpenAiSubscriptionFlow } from "@/components/openai-subscription-flow";

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = vi.fn();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

describe("OpenAiSubscriptionFlow", () => {
  it("renders Connect button initially", () => {
    render(<OpenAiSubscriptionFlow onConnected={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Connect with ChatGPT/i })).toBeInTheDocument();
  });

  it("shows user code and link after clicking Connect", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            flowId: "f1",
            userCode: "ABCD-EFGH",
            verificationUri: "https://auth.openai.com/codex/device",
            verificationUriComplete: "https://auth.openai.com/codex/device?user_code=ABCD-EFGH",
            interval: 5,
            expiresIn: 900,
          })
        )
      )
      // Subsequent poll calls return pending so we don't advance to complete
      .mockResolvedValue(new Response(JSON.stringify({ status: "pending" })));

    render(<OpenAiSubscriptionFlow onConnected={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Connect with ChatGPT/i }));
    await waitFor(() => expect(screen.getByText("ABCD-EFGH")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /Open chatgpt\.com\/auth\/device/i })).toHaveAttribute(
      "href",
      "https://auth.openai.com/codex/device?user_code=ABCD-EFGH"
    );
  });

  it("calls onConnected when poll returns complete", async () => {
    const onConnected = vi.fn();
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            flowId: "f1",
            userCode: "X",
            verificationUri: "u",
            verificationUriComplete: "uc",
            interval: 0,
            expiresIn: 60,
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: "complete", accountEmail: "u@e.com", accountId: "acc-1" })
        )
      );

    render(<OpenAiSubscriptionFlow onConnected={onConnected} />);
    await userEvent.click(screen.getByRole("button", { name: /Connect with ChatGPT/i }));
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith({ accountEmail: "u@e.com" }), {
      timeout: 3000,
    });
  });

  it("shows error message when start request fails", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response("error", { status: 500 })
    );
    render(<OpenAiSubscriptionFlow onConnected={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Connect with ChatGPT/i }));
    await waitFor(() =>
      expect(screen.getByText(/Could not start authorization/i)).toBeInTheDocument()
    );
  });
});
