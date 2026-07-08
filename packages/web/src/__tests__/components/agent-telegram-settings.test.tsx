import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("renders the setup form for Smithers even when main bot is not configured", async () => {
    global.fetch = mockFetch({ configured: false, mainBotConfigured: false });

    render(<AgentTelegramSettings agentId="smithers-1" isSmithers />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Bot Token/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Telegram isn't set up yet/i)).not.toBeInTheDocument();
  });

  // #476 gap 2: a non-admin owner can DISCONNECT their personal bot, but the
  // connect path stays admin-only. So a non-admin must not be shown a bot-token
  // form they cannot submit (POST would 403) — show an ask-your-admin note.
  it("shows an ask-your-admin note instead of the connect form for non-admins", async () => {
    global.fetch = mockFetch({ configured: false, mainBotConfigured: true });

    render(<AgentTelegramSettings agentId="smithers-1" isSmithers isAdmin={false} />);

    await waitFor(() => {
      expect(screen.getByText(/administrator/i)).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/Bot Token/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Connect$/i })).not.toBeInTheDocument();
  });

  it("still renders the connect form when isAdmin is not specified (default)", async () => {
    global.fetch = mockFetch({ configured: false, mainBotConfigured: true });

    render(<AgentTelegramSettings agentId="agent-1" />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Bot Token/i)).toBeInTheDocument();
    });
  });

  // #477 layer 2: an account auto-disabled after a sustained getUpdates-409
  // conflict must show a PERSISTENT inline actionable state (not a toast —
  // this is a permanent condition per the project's error/notification
  // policy), with a way to re-enable it.
  describe("conflict auto-disabled state (#477 layer 2)", () => {
    it("renders a persistent disabled message with a Reconnect button when conflictDisabled is true", async () => {
      global.fetch = mockFetch({
        configured: true,
        hint: "xY9z",
        mainBotConfigured: true,
        conflictDisabled: true,
        lastError: "Conflict: terminated by other getUpdates request",
      });

      render(<AgentTelegramSettings agentId="agent-1" />);

      await waitFor(() => {
        expect(screen.getByText(/disabled/i)).toBeInTheDocument();
      });
      expect(
        screen.getByText(/another deployment|separate token|stopped it there/i)
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /reconnect/i })).toBeInTheDocument();
    });

    it("does not render the disabled banner when conflictDisabled is false", async () => {
      global.fetch = mockFetch({
        configured: true,
        hint: "xY9z",
        mainBotConfigured: true,
        conflictDisabled: false,
      });

      render(<AgentTelegramSettings agentId="agent-1" />);

      await waitFor(() => {
        expect(screen.getByText(/Connected/i)).toBeInTheDocument();
      });
      expect(screen.queryByRole("button", { name: /reconnect/i })).not.toBeInTheDocument();
    });

    it("clicking Reconnect reveals the connect flow so the user can re-submit a token", async () => {
      global.fetch = mockFetch({
        configured: true,
        hint: "xY9z",
        mainBotConfigured: true,
        conflictDisabled: true,
        lastError: "Conflict: terminated by other getUpdates request",
      });

      render(<AgentTelegramSettings agentId="agent-1" />);

      const reconnectButton = await screen.findByRole("button", { name: /reconnect/i });
      await userEvent.click(reconnectButton);

      expect(screen.getByLabelText(/Bot Token/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^Connect$/i })).toBeInTheDocument();
    });
  });
});
