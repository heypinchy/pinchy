import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProviderKeyForm } from "@/components/provider-key-form";
import { toast } from "sonner";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = vi.fn();
  // Default: no subscription connected
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
    new Response(JSON.stringify({ connected: false }))
  );
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

describe("ProviderKeyForm — OpenAI subscription", () => {
  it("shows auth method toggle when OpenAI is selected", async () => {
    render(<ProviderKeyForm onSuccess={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /OpenAI/i }));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /API Key/i })).toBeInTheDocument()
    );
    expect(screen.getByRole("radio", { name: /ChatGPT Subscription/i })).toBeInTheDocument();
  });

  it("does not show toggle for Anthropic", async () => {
    render(<ProviderKeyForm onSuccess={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /Anthropic/i }));
    await waitFor(() =>
      expect(screen.queryByRole("radio", { name: /ChatGPT Subscription/i })).not.toBeInTheDocument()
    );
  });

  it("renders Connect with ChatGPT button when Subscription method selected", async () => {
    render(<ProviderKeyForm onSuccess={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /OpenAI/i }));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /ChatGPT Subscription/i })).toBeInTheDocument()
    );
    await userEvent.click(screen.getByRole("radio", { name: /ChatGPT Subscription/i }));
    expect(
      await screen.findByRole("button", { name: /Connect with ChatGPT/i })
    ).toBeInTheDocument();
  });

  it("shows connected state when subscription is active", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          connected: true,
          accountEmail: "u@e.com",
          connectedAt: "2026-04-20T09:00:00Z",
          refreshFailureCount: 0,
        })
      )
    );
    render(<ProviderKeyForm onSuccess={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /OpenAI/i }));
    await waitFor(() => expect(screen.getByText(/Connected as/i)).toBeInTheDocument());
    expect(screen.getByText("u@e.com")).toBeInTheDocument();
  });

  it("switching to Subscription while an API key exists shows a replace-confirmation", async () => {
    // subscription endpoint returns not connected
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ connected: false }))
    );
    render(
      <ProviderKeyForm
        onSuccess={vi.fn()}
        configuredProviders={{ openai: { configured: true, hint: "sk-…1234" } }}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: /OpenAI/i }));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /ChatGPT Subscription/i })).toBeInTheDocument()
    );
    await userEvent.click(screen.getByRole("radio", { name: /ChatGPT Subscription/i }));
    // AlertDialog should appear
    expect(await screen.findByText("Replace API key?")).toBeInTheDocument();
    // OpenAiSubscriptionFlow should NOT yet be visible
    expect(screen.queryByRole("button", { name: /Connect with ChatGPT/i })).not.toBeInTheDocument();
  });

  it("shows affected agents list in disconnect dialog when agents use OpenAI", async () => {
    // First call: subscription status; second call: affected agents
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            connected: true,
            accountEmail: "u@e.com",
            connectedAt: "2026-04-20T09:00:00Z",
            refreshFailureCount: 0,
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { id: "a1", name: "GPT Agent" },
            { id: "a2", name: "Codex Agent" },
          ])
        )
      );

    render(<ProviderKeyForm onSuccess={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /OpenAI/i }));
    await waitFor(() => expect(screen.getByText(/Connected as/i)).toBeInTheDocument());

    // Open the disconnect dialog
    await userEvent.click(screen.getByRole("button", { name: /Disconnect/i }));

    // Should show affected agents
    await waitFor(() => expect(screen.getByText("GPT Agent")).toBeInTheDocument());
    expect(screen.getByText("Codex Agent")).toBeInTheDocument();
  });

  it("does not show agent list in disconnect dialog when no agents use OpenAI", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            connected: true,
            accountEmail: "u@e.com",
            connectedAt: "2026-04-20T09:00:00Z",
            refreshFailureCount: 0,
          })
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([])));

    render(<ProviderKeyForm onSuccess={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /OpenAI/i }));
    await waitFor(() => expect(screen.getByText(/Connected as/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /Disconnect/i }));

    // Should not show any agent list items
    await waitFor(() => expect(screen.queryByRole("listitem")).not.toBeInTheDocument());
  });

  it("shows error toast when disconnect API call fails", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            connected: true,
            accountEmail: "x@y.com",
            connectedAt: "2026-04-20T09:00:00Z",
            refreshFailureCount: 0,
          })
        )
      )
      // agents pre-fetch
      .mockResolvedValueOnce(new Response(JSON.stringify([])))
      // DELETE subscription → 500
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Internal error" }), { status: 500 })
      );

    render(<ProviderKeyForm onSuccess={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /OpenAI/i }));
    await waitFor(() => expect(screen.getByText(/Connected as/i)).toBeInTheDocument());

    // Open disconnect dialog
    await userEvent.click(screen.getByRole("button", { name: /Disconnect/i }));
    // Wait for dialog then confirm disconnect (dialog action button)
    const disconnectButtons = await screen.findAllByRole("button", { name: /Disconnect/i });
    await userEvent.click(disconnectButtons[disconnectButtons.length - 1]);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Failed to disconnect. Please try again.")
    );
  });

  it("does not show reconnect banner when refreshFailureCount < 2", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          connected: true,
          accountEmail: "x@y.com",
          connectedAt: "2026-04-20T09:00:00Z",
          refreshFailureCount: 1,
        })
      )
    );
    render(<ProviderKeyForm onSuccess={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /OpenAI/i }));
    await waitFor(() => expect(screen.getByText(/Connected as/i)).toBeInTheDocument());
    expect(
      screen.queryByText(/Your ChatGPT subscription needs to be reconnected/i)
    ).not.toBeInTheDocument();
  });

  it("shows reconnect banner when refreshFailureCount >= 2", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          connected: true,
          accountEmail: "x@y.com",
          connectedAt: "2026-04-20T09:00:00Z",
          refreshFailureCount: 2,
        })
      )
    );
    render(<ProviderKeyForm onSuccess={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /OpenAI/i }));
    await waitFor(() =>
      expect(
        screen.getByText(/Your ChatGPT subscription needs to be reconnected/i)
      ).toBeInTheDocument()
    );
    expect(screen.getByText(/Token refresh failed 2 or more times/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Reconnect$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Dismiss$/i })).toBeInTheDocument();
  });

  it("Dismiss button hides the banner without resetting server state", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          connected: true,
          accountEmail: "x@y.com",
          connectedAt: "2026-04-20T09:00:00Z",
          refreshFailureCount: 3,
        })
      )
    );
    render(<ProviderKeyForm onSuccess={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /OpenAI/i }));
    await waitFor(() =>
      expect(
        screen.getByText(/Your ChatGPT subscription needs to be reconnected/i)
      ).toBeInTheDocument()
    );

    await userEvent.click(screen.getByRole("button", { name: /^Dismiss$/i }));

    expect(
      screen.queryByText(/Your ChatGPT subscription needs to be reconnected/i)
    ).not.toBeInTheDocument();

    // No DELETE or PATCH was made — only the initial GET
    const allCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      RequestInit?,
    ][];
    const mutatingCalls = allCalls.filter(
      ([, init]) => init?.method === "DELETE" || init?.method === "PATCH"
    );
    expect(mutatingCalls).toHaveLength(0);
  });

  // TODO: covered by E2E — onConnected re-fetch can't be unit tested without full OAuth simulation
});
