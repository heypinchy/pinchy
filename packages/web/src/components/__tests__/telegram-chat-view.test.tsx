import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TelegramChatView } from "@/components/telegram-chat-view";
import { ApiError } from "@/lib/api-client";
import type { TelegramTranscriptMessage } from "@/lib/schemas/sessions";

// --- mocks ----------------------------------------------------------------
//
// Mirrors chat-switcher.test.tsx: stub next/navigation and apiGet, and flatten
// the Radix dropdown so the embedded <ChatSwitcher> renders without portal /
// pointer-capture mechanics.

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiGet: vi.fn() };
});
import { apiGet } from "@/lib/api-client";

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div role="menu">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" role="menuitem" disabled={disabled} onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// --- fixtures -------------------------------------------------------------

const messages: TelegramTranscriptMessage[] = [
  { role: "user", text: "Hello from Telegram", timestamp: 1_000 },
  { role: "assistant", text: "Hi! I'm Smithers, replying on Telegram.", timestamp: 2_000 },
  { role: "user", text: "Great, thanks", timestamp: 3_000 },
];

const BOT_DEEP_LINK = "https://t.me/my_pinchy_bot";

function mockTranscript(botDeepLink: string | null) {
  (apiGet as ReturnType<typeof vi.fn>).mockResolvedValue({ messages, botDeepLink });
}

function renderView(overrides: Partial<React.ComponentProps<typeof TelegramChatView>> = {}) {
  return render(
    <TelegramChatView
      agentId="agent-1"
      agentName="Smithers"
      avatarUrl="data:image/svg+xml;utf8,mock"
      isPersonal={false}
      canEdit={false}
      {...overrides}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // ChatSwitcher (embedded in the header) fetches its chat list separately.
  // Default it to an empty list; per-test mocks for the transcript override
  // the first call.
  (apiGet as ReturnType<typeof vi.fn>).mockResolvedValue({ chats: [] });
});

// --- tests ----------------------------------------------------------------

describe("TelegramChatView", () => {
  it("fetches the transcript from the telegram-chat endpoint on mount", async () => {
    mockTranscript(BOT_DEEP_LINK);
    renderView();

    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/api/agents/agent-1/telegram-chat"));
  });

  it("renders the messages read-only as role-styled bubbles, in order", async () => {
    mockTranscript(BOT_DEEP_LINK);
    renderView();

    expect(await screen.findByText("Hello from Telegram")).toBeInTheDocument();
    expect(screen.getByText("Hi! I'm Smithers, replying on Telegram.")).toBeInTheDocument();
    expect(screen.getByText("Great, thanks")).toBeInTheDocument();

    // The transcript renders in the order the API returned them.
    const transcript = screen.getByTestId("telegram-transcript");
    const bubbleTexts = within(transcript)
      .getAllByTestId(/^telegram-message-/)
      .map((el) => el.textContent);
    const firstUser = bubbleTexts.findIndex((t) => t?.includes("Hello from Telegram"));
    const assistant = bubbleTexts.findIndex((t) => t?.includes("replying on Telegram"));
    const secondUser = bubbleTexts.findIndex((t) => t?.includes("Great, thanks"));
    expect(firstUser).toBeLessThan(assistant);
    expect(assistant).toBeLessThan(secondUser);

    // Role is encoded so user and assistant bubbles are visually distinct.
    const userBubble = within(transcript).getByText("Hello from Telegram").closest("[data-role]")!;
    const assistantBubble = within(transcript)
      .getByText("Hi! I'm Smithers, replying on Telegram.")
      .closest("[data-role]")!;
    expect(userBubble.getAttribute("data-role")).toBe("user");
    expect(assistantBubble.getAttribute("data-role")).toBe("assistant");
  });

  it("shows a clear Telegram channel indicator in the header", async () => {
    mockTranscript(BOT_DEEP_LINK);
    renderView();

    const header = await screen.findByTestId("telegram-chat-header");
    // A dedicated channel-indicator badge surfaces "Telegram" so the channel is
    // unmistakable, distinct from the chat-switcher trigger.
    const indicator = within(header).getByTestId("telegram-channel-indicator");
    expect(indicator).toHaveTextContent("Telegram");
  });

  it("reflects the agent's visibility in the header (Private vs Shared)", async () => {
    mockTranscript(BOT_DEEP_LINK);
    renderView({ isPersonal: true });
    let header = await screen.findByTestId("telegram-chat-header");
    expect(within(header).getByText("Private")).toBeInTheDocument();

    renderView({ isPersonal: false });
    header = (await screen.findAllByTestId("telegram-chat-header"))[1];
    expect(within(header).getByText("Shared")).toBeInTheDocument();
  });

  it("shows a Settings link only when the user can edit the agent", async () => {
    mockTranscript(BOT_DEEP_LINK);
    const { unmount } = renderView({ canEdit: true });
    const editable = await screen.findByTestId("telegram-chat-header");
    expect(within(editable).getByRole("link", { name: /settings/i })).toHaveAttribute(
      "href",
      "/chat/agent-1/settings"
    );

    unmount();
    renderView({ canEdit: false });
    const readOnly = await screen.findByTestId("telegram-chat-header");
    expect(within(readOnly).queryByRole("link", { name: /settings/i })).toBeNull();
  });

  it("renders NO composer / message input (read-only)", async () => {
    mockTranscript(BOT_DEEP_LINK);
    renderView();

    await screen.findByText("Hello from Telegram");

    // No textbox, no textarea — the conversation can't be typed into here.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.querySelector("input[type='text']")).toBeNull();
  });

  it("shows a 'Continue on Telegram' link to the bot deep link when present", async () => {
    mockTranscript(BOT_DEEP_LINK);
    renderView();

    const link = await screen.findByRole("link", { name: /continue on telegram/i });
    expect(link).toHaveAttribute("href", BOT_DEEP_LINK);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));

    // The read-only banner explains where the conversation actually happens.
    expect(screen.getByText(/this conversation happens on telegram/i)).toBeInTheDocument();
  });

  it("omits the 'Continue on Telegram' link gracefully when the deep link is null", async () => {
    mockTranscript(null);
    renderView();

    // Banner text still renders so the read-only nature is explained.
    expect(await screen.findByText(/this conversation happens on telegram/i)).toBeInTheDocument();
    // ...but there is no actionable link without a deep link.
    expect(screen.queryByRole("link", { name: /continue on telegram/i })).toBeNull();
  });

  it("shows a loading state while the transcript is fetching", async () => {
    let resolve!: (value: {
      messages: TelegramTranscriptMessage[];
      botDeepLink: string | null;
    }) => void;
    (apiGet as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url.endsWith("/telegram-chat")) {
        return new Promise((r) => {
          resolve = r;
        });
      }
      return Promise.resolve({ chats: [] });
    });

    renderView();

    // Scope to the transcript body so we assert the transcript's own loading
    // state, not the embedded chat-switcher's separate "Loading your chats…".
    const body = screen.getByTestId("telegram-chat-body");
    expect(within(body).getByText(/loading/i)).toBeInTheDocument();

    resolve({ messages, botDeepLink: BOT_DEEP_LINK });
    await waitFor(() => expect(within(body).queryByText(/loading/i)).toBeNull());
  });

  it("shows an empty state when no Telegram conversation is linked (404)", async () => {
    (apiGet as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url.endsWith("/telegram-chat")) {
        return Promise.reject(new ApiError(404, "No linked Telegram conversation"));
      }
      return Promise.resolve({ chats: [] });
    });

    renderView();

    expect(await screen.findByText(/no telegram conversation linked/i)).toBeInTheDocument();
  });
});
