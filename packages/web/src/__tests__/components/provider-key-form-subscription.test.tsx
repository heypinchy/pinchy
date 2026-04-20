import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProviderKeyForm } from "@/components/provider-key-form";

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

  // TODO: covered by E2E — onConnected re-fetch can't be unit tested without full OAuth simulation
});
