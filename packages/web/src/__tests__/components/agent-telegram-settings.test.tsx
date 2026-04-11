import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import { AgentTelegramSettings } from "@/components/agent-telegram-settings";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/restart-provider", () => ({
  useRestart: () => ({ triggerRestart: vi.fn() }),
}));

function mockFetch(response: object) {
  return vi.fn().mockImplementation((url: string) => {
    if (typeof url === "string" && url.includes("/channels/telegram")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(response) });
    }
    return Promise.resolve({ ok: false });
  });
}

describe("AgentTelegramSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders empty state when main bot is not configured", async () => {
    global.fetch = mockFetch({ configured: false, mainBotConfigured: false });

    render(<AgentTelegramSettings agentId="agent-1" />);

    await waitFor(() => {
      expect(screen.getByText(/Telegram isn't set up yet/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Pinchy's main bot needs to be configured first/i)).toBeInTheDocument();
  });

  it("empty state has a link to the global Telegram settings page", async () => {
    global.fetch = mockFetch({ configured: false, mainBotConfigured: false });

    render(<AgentTelegramSettings agentId="agent-1" />);

    await waitFor(() => {
      const link = screen.getByRole("link", { name: /Go to Telegram Settings/i });
      expect(link).toHaveAttribute("href", "/settings?tab=telegram");
    });
  });

  it("does not render the BotFather setup form in the empty state", async () => {
    global.fetch = mockFetch({ configured: false, mainBotConfigured: false });

    render(<AgentTelegramSettings agentId="agent-1" />);

    await waitFor(() => {
      expect(screen.getByText(/Telegram isn't set up yet/i)).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/Bot Token/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Connect$/i })).not.toBeInTheDocument();
  });

  it("renders the setup form when main bot is configured and agent has no bot", async () => {
    global.fetch = mockFetch({ configured: false, mainBotConfigured: true });

    render(<AgentTelegramSettings agentId="agent-1" />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Bot Token/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Telegram isn't set up yet/i)).not.toBeInTheDocument();
  });

  it("renders the connected state when agent has its own bot, regardless of main bot flag", async () => {
    // Defensive: this combination shouldn't happen in production, but the UI
    // must not regress to empty state if it does.
    global.fetch = mockFetch({
      configured: true,
      hint: "xY9z",
      mainBotConfigured: false,
    });

    render(<AgentTelegramSettings agentId="agent-1" />);

    await waitFor(() => {
      expect(screen.getByText(/Connected/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Telegram isn't set up yet/i)).not.toBeInTheDocument();
  });
});
