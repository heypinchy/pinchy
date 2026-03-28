import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TelegramLinkSettings } from "@/components/telegram-link-settings";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function mockFetch(linkStatus: object, bots: object[], agents?: object[]) {
  return vi.fn().mockImplementation((url: string) => {
    if (url === "/api/settings/telegram") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(linkStatus) });
    }
    if (url === "/api/settings/telegram/bots") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ bots }) });
    }
    if (url === "/api/agents" && agents) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(agents) });
    }
    // AgentTelegramSettings fetches /api/agents/<id>/channels/telegram
    if (typeof url === "string" && url.includes("/channels/telegram")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ configured: false }) });
    }
    return Promise.resolve({ ok: false });
  });
}

describe("TelegramLinkSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows setup button for admin when no bots configured", async () => {
    global.fetch = mockFetch(
      { linked: false },
      [],
      [{ id: "a1", name: "Smithers", isPersonal: false }]
    );

    render(<TelegramLinkSettings isAdmin={true} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Set up Telegram" })).toBeInTheDocument();
    });
  });

  it("shows 'not set up' message for members when no bots configured", async () => {
    global.fetch = mockFetch({ linked: false }, []);

    render(<TelegramLinkSettings isAdmin={false} />);

    await waitFor(() => {
      expect(screen.getByText(/isn't set up yet/i)).toBeInTheDocument();
    });
  });

  it("shows QR code in step 1, pairing input in step 2", async () => {
    global.fetch = mockFetch({ linked: false }, [
      { agentId: "a1", agentName: "Smithers", botUsername: "acme_smithers_bot" },
    ]);

    render(<TelegramLinkSettings isAdmin={false} />);

    // Step 1: QR code
    await waitFor(() => {
      expect(screen.getByText(/Scan this code/i)).toBeInTheDocument();
    });
    const link = screen.getByRole("link", { name: /open in Telegram/i });
    expect(link).toHaveAttribute("href", "https://t.me/acme_smithers_bot");
    expect(screen.queryByPlaceholderText(/ABC123XY/i)).not.toBeInTheDocument();

    // Click to go to step 2
    await userEvent.click(screen.getByRole("button", { name: /I sent a message/i }));

    // Step 2: pairing code input + example message
    expect(screen.getByPlaceholderText(/ABC123XY/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Pairing Code/i)).toBeInTheDocument();
  });

  it("shows linked state when user is linked", async () => {
    global.fetch = mockFetch({ linked: true, channelUserId: "12345" }, []);

    render(<TelegramLinkSettings isAdmin={false} />);

    await waitFor(() => {
      expect(screen.getByText("Linked")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /Unlink/i })).toBeInTheDocument();
  });

  it("shows AgentTelegramSettings when admin clicks setup button", async () => {
    global.fetch = mockFetch(
      { linked: false },
      [],
      [{ id: "a1", name: "Smithers", isPersonal: true, avatarSeed: "__smithers__" }]
    );

    render(<TelegramLinkSettings isAdmin={true} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Set up Telegram" })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "Set up Telegram" }));

    // AgentTelegramSettings is now embedded with the bot token form
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/bot token/i)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
  });
});
