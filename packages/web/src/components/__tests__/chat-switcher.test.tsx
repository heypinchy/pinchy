import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { ChatSwitcher } from "@/components/chat-switcher";
import { chatIdSchema } from "@/lib/schemas/sessions";
import type { ChatListItem } from "@/lib/schemas/sessions";

// --- mocks ----------------------------------------------------------------

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiGet: vi.fn() };
});
import { apiGet } from "@/lib/api-client";

// Render the dropdown content inline so we can assert items without Radix's
// portal + pointer-capture mechanics (same approach template-selector.test.tsx
// uses for tooltips). We also expose a hidden "open-dropdown" button that fires
// `onOpenChange(true)` so tests can simulate opening the menu (the component
// re-fetches its chat list on open).
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({
    children,
    onOpenChange,
  }: {
    children: React.ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => (
    <div>
      <button type="button" data-testid="open-dropdown" onClick={() => onOpenChange?.(true)}>
        open
      </button>
      {children}
    </div>
  ),
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

const webChat: ChatListItem = {
  chatId: "chat-abc",
  sessionId: "s-web-new",
  origin: "web",
  writable: true,
  title: "Quarterly report",
  lastInteractionAt: 5_000,
};

const legacyChat: ChatListItem = {
  chatId: null,
  sessionId: "s-web-legacy",
  origin: "web",
  writable: true,
  title: null, // forces the date fallback title
  lastInteractionAt: 1_000,
};

const telegramChat: ChatListItem = {
  chatId: null,
  sessionId: "s-telegram",
  origin: "telegram",
  writable: false,
  title: "Telegram chat",
  lastInteractionAt: 3_000,
};

const allChats: ChatListItem[] = [webChat, telegramChat, legacyChat];

function mockChats(chats: ChatListItem[]) {
  (apiGet as ReturnType<typeof vi.fn>).mockResolvedValue({ chats });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// --- tests ----------------------------------------------------------------

describe("ChatSwitcher", () => {
  it("fetches and renders chats with titles, falling back to a localized date for null titles", async () => {
    mockChats(allChats);
    render(<ChatSwitcher agentId="agent-1" chatId="chat-abc" agentName="Smithers" />);

    expect(apiGet).toHaveBeenCalledWith("/api/agents/agent-1/chats");

    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Quarterly report")).toBeInTheDocument();
    expect(within(menu).getByText("Telegram chat")).toBeInTheDocument();

    // legacyChat has a null title → fallback "Chat from <localized date>".
    const fallback = new Date(legacyChat.lastInteractionAt).toLocaleDateString();
    expect(within(menu).getByText(`Chat from ${fallback}`)).toBeInTheDocument();
  });

  it("shows the Telegram badge and a read-only marker only on the Telegram chat", async () => {
    mockChats(allChats);
    render(<ChatSwitcher agentId="agent-1" chatId="chat-abc" agentName="Smithers" />);

    const menu = await screen.findByRole("menu");

    // Exactly one Telegram badge and one read-only marker.
    expect(within(menu).getByText("Telegram")).toBeInTheDocument();
    const readOnlyMarkers = within(menu).getAllByLabelText("Read-only");
    expect(readOnlyMarkers).toHaveLength(1);

    // The read-only marker belongs to the Telegram row, not a web row.
    const telegramRow = within(menu).getByText("Telegram chat").closest("[role='menuitem']")!;
    expect(within(telegramRow as HTMLElement).getByLabelText("Read-only")).toBeInTheDocument();

    const webRow = within(menu).getByText("Quarterly report").closest("[role='menuitem']")!;
    expect(within(webRow as HTMLElement).queryByLabelText("Read-only")).toBeNull();
    expect(within(webRow as HTMLElement).queryByText("Telegram")).toBeNull();
  });

  it("marks the active chat (matching the chatId prop) with an active indicator", async () => {
    mockChats(allChats);
    render(<ChatSwitcher agentId="agent-1" chatId="chat-abc" agentName="Smithers" />);

    const menu = await screen.findByRole("menu");

    const activeRow = within(menu).getByText("Quarterly report").closest("[role='menuitem']")!;
    expect(within(activeRow as HTMLElement).getByLabelText("Current chat")).toBeInTheDocument();

    // A different web chat is not marked active.
    const telegramRow = within(menu).getByText("Telegram chat").closest("[role='menuitem']")!;
    expect(within(telegramRow as HTMLElement).queryByLabelText("Current chat")).toBeNull();
  });

  it("treats the default chat (chatId null) as active when chatId prop is null", async () => {
    mockChats(allChats);
    render(<ChatSwitcher agentId="agent-1" chatId={null} agentName="Smithers" />);

    const menu = await screen.findByRole("menu");

    // The legacy/default web chat (chatId null) is the active one now.
    const fallback = new Date(legacyChat.lastInteractionAt).toLocaleDateString();
    const defaultRow = within(menu)
      .getByText(`Chat from ${fallback}`)
      .closest("[role='menuitem']")!;
    expect(within(defaultRow as HTMLElement).getByLabelText("Current chat")).toBeInTheDocument();

    // The Telegram chat also has chatId null but is a different origin/session,
    // so it must NOT be treated as the active default chat.
    const telegramRow = within(menu).getByText("Telegram chat").closest("[role='menuitem']")!;
    expect(within(telegramRow as HTMLElement).queryByLabelText("Current chat")).toBeNull();
  });

  it("starting a new chat pushes /chat/<agentId>/<schema-valid chatId>", async () => {
    const user = userEvent.setup();
    mockChats(allChats);
    render(<ChatSwitcher agentId="agent-1" chatId="chat-abc" agentName="Smithers" />);

    await screen.findByRole("menu");
    await user.click(screen.getByRole("menuitem", { name: /New chat/i }));

    expect(push).toHaveBeenCalledTimes(1);
    const pushed = push.mock.calls[0][0] as string;
    const prefix = "/chat/agent-1/";
    expect(pushed.startsWith(prefix)).toBe(true);

    const newId = pushed.slice(prefix.length);
    expect(chatIdSchema.safeParse(newId).success).toBe(true);
  });

  it("selecting a web chat pushes /chat/<agentId>/<chatId>", async () => {
    const user = userEvent.setup();
    mockChats(allChats);
    render(<ChatSwitcher agentId="agent-1" chatId={null} agentName="Smithers" />);

    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Quarterly report"));

    expect(push).toHaveBeenCalledWith("/chat/agent-1/chat-abc");
  });

  it("selecting the default chat (chatId null) pushes /chat/<agentId>", async () => {
    const user = userEvent.setup();
    mockChats(allChats);
    render(<ChatSwitcher agentId="agent-1" chatId="chat-abc" agentName="Smithers" />);

    const menu = await screen.findByRole("menu");
    const fallback = new Date(legacyChat.lastInteractionAt).toLocaleDateString();
    await user.click(within(menu).getByText(`Chat from ${fallback}`));

    expect(push).toHaveBeenCalledWith("/chat/agent-1");
  });

  it("selecting a Telegram chat pushes /chat/<agentId>/telegram (the read-only mirror)", async () => {
    const user = userEvent.setup();
    mockChats(allChats);
    render(<ChatSwitcher agentId="agent-1" chatId="chat-abc" agentName="Smithers" />);

    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Telegram chat"));

    // Telegram chats have a null chatId but must NOT collide with the default
    // web chat — they navigate to the dedicated read-only Telegram view.
    expect(push).toHaveBeenCalledWith("/chat/agent-1/telegram");
  });

  it("marks the Telegram chat active and labels the trigger 'Telegram' when activeTelegram is set", async () => {
    mockChats(allChats);
    render(<ChatSwitcher agentId="agent-1" chatId={null} agentName="Smithers" activeTelegram />);

    const menu = await screen.findByRole("menu");

    // On the Telegram view, the Telegram row carries the active indicator...
    const telegramRow = within(menu).getByText("Telegram chat").closest("[role='menuitem']")!;
    expect(within(telegramRow as HTMLElement).getByLabelText("Current chat")).toBeInTheDocument();

    // ...and the default web chat is NOT treated as active even though chatId is null.
    const fallback = new Date(legacyChat.lastInteractionAt).toLocaleDateString();
    const defaultRow = within(menu)
      .getByText(`Chat from ${fallback}`)
      .closest("[role='menuitem']")!;
    expect(within(defaultRow as HTMLElement).queryByLabelText("Current chat")).toBeNull();

    // The trigger reflects the Telegram channel.
    expect(screen.getByRole("button", { name: /Telegram/i })).toBeInTheDocument();
  });

  it("shows a loading state while fetching", async () => {
    let resolve!: (value: { chats: ChatListItem[] }) => void;
    (apiGet as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );

    render(<ChatSwitcher agentId="agent-1" chatId={null} agentName="Smithers" />);

    expect(screen.getByText(/Loading/i)).toBeInTheDocument();

    resolve({ chats: allChats });
    await waitFor(() => expect(screen.queryByText(/Loading/i)).toBeNull());
  });

  it("shows an empty state when there are no chats", async () => {
    mockChats([]);
    // The empty state is only reachable on the read-only Telegram view: the web
    // view always synthesizes the current chat optimistically (see Fix 1), so a
    // web list is never truly empty. On the Telegram view there's no web chat to
    // synthesize, so an empty server list stays empty.
    render(<ChatSwitcher agentId="agent-1" chatId={null} agentName="Smithers" activeTelegram />);

    expect(await screen.findByText(/No other chats yet/i)).toBeInTheDocument();
  });

  it("degrades to an empty list when the fetch fails", async () => {
    (apiGet as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network"));
    // On the Telegram view nothing is synthesized, so a failed fetch settles to
    // the empty state — proving the failure path doesn't crash the header.
    render(<ChatSwitcher agentId="agent-1" chatId={null} agentName="Smithers" activeTelegram />);

    expect(await screen.findByText(/No other chats yet/i)).toBeInTheDocument();
  });

  it("on the web view, a failed fetch still shows the current chat optimistically (no crash)", async () => {
    (apiGet as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network"));
    render(<ChatSwitcher agentId="agent-1" chatId={null} agentName="Smithers" />);

    // The default web chat is always visible even when the list fails to load.
    const menu = await screen.findByRole("menu");
    expect(optimisticRow(menu)).not.toBeNull();
  });

  it("renders the current chat's title in the trigger", async () => {
    mockChats(allChats);
    render(<ChatSwitcher agentId="agent-1" chatId="chat-abc" agentName="Smithers" />);

    // The trigger reflects the active chat's title once loaded.
    expect(await screen.findByRole("button", { name: /Quarterly report/i })).toBeInTheDocument();
  });

  // --- Fix 1: current/new chat is always visible (optimistic + refetch) -----

  // The permanent "New chat" ACTION item (the one with the Plus icon that starts
  // a fresh chat) also reads "New chat", so we can't disambiguate the synthetic
  // current-chat ROW by text alone. A chat ROW renders its title inside a
  // `truncate` span (the action item's label is a bare text node) — that's the
  // stable structural discriminator. Returns the synthetic row, or null when no
  // optimistic row was synthesized.
  function optimisticRow(menu: HTMLElement): HTMLElement | null {
    return (
      within(menu)
        .getAllByText("New chat")
        .filter((el) => el.classList.contains("truncate"))
        .map((el) => el.closest("[role='menuitem']") as HTMLElement | null)
        .find((row): row is HTMLElement => row != null) ?? null
    );
  }

  it("optimistically shows a brand-new chat (not in the server list) as the active 'New chat'", async () => {
    // The server list does NOT contain the current chatId — a brand-new chat
    // that has not produced an OpenClaw session yet.
    mockChats([webChat, telegramChat, legacyChat]);
    render(<ChatSwitcher agentId="agent-1" chatId="brand-new-chat" agentName="Smithers" />);

    const menu = await screen.findByRole("menu");

    // A synthetic "New chat" row appears, marked active.
    const newChatRow = optimisticRow(menu)!;
    expect(newChatRow).not.toBeNull();
    expect(within(newChatRow).getByLabelText("Current chat")).toBeInTheDocument();

    // The persistent header trigger keeps the agent name for an untitled
    // optimistic chat (not a generic "New chat") — the dropdown row carries the
    // "New chat" label, the header stays the agent identity.
    expect(screen.getByRole("button", { name: /Smithers/i })).toBeInTheDocument();

    // It sorts to the top (newest), ahead of the server chats — it's the first
    // chat row (a menuitem whose title sits in a `truncate` span) below the
    // "New chat" action item + separator.
    const rows = within(menu).getAllByRole("menuitem");
    const firstChatRow = rows.find((r) => r.querySelector(".truncate") != null)!;
    expect(firstChatRow.textContent).toContain("New chat");
  });

  it("optimistically shows the default web chat (chatId null) as 'New chat' when the server list lacks it", async () => {
    // Server list has only a telegram chat — no web chat at all. The default
    // web chat (chatId null) must still surface optimistically and active.
    mockChats([telegramChat]);
    render(<ChatSwitcher agentId="agent-1" chatId={null} agentName="Smithers" />);

    const menu = await screen.findByRole("menu");
    const newChatRow = optimisticRow(menu)!;
    expect(newChatRow).not.toBeNull();
    expect(within(newChatRow).getByLabelText("Current chat")).toBeInTheDocument();
  });

  it("does NOT synthesize a duplicate when the current chat IS in the server list", async () => {
    mockChats(allChats);
    render(<ChatSwitcher agentId="agent-1" chatId="chat-abc" agentName="Smithers" />);

    const menu = await screen.findByRole("menu");

    // The current chat (chat-abc) is the server's "Quarterly report" entry — it
    // is shown as-is, with no extra synthetic "New chat" row.
    expect(optimisticRow(menu)).toBeNull();
    const activeRow = within(menu).getByText("Quarterly report").closest("[role='menuitem']")!;
    expect(within(activeRow as HTMLElement).getByLabelText("Current chat")).toBeInTheDocument();
  });

  it("does NOT synthesize a web 'New chat' when on the read-only Telegram view", async () => {
    // On the Telegram view chatId is null but activeTelegram is set — the active
    // chat is the telegram row, so we must not invent a web "New chat".
    mockChats([telegramChat]);
    render(<ChatSwitcher agentId="agent-1" chatId={null} agentName="Smithers" activeTelegram />);

    const menu = await screen.findByRole("menu");
    expect(optimisticRow(menu)).toBeNull();
  });

  it("shows 'Not saved yet' on the synthetic new-chat row, never a far-future time", async () => {
    // The optimistic row carries a MAX_SAFE_INTEGER sentinel timestamp so it
    // sorts to the top; it must NOT render as a relative time ("in 292 million
    // years"). A brand-new chat has no real interaction time yet.
    mockChats([webChat, telegramChat, legacyChat]);
    render(<ChatSwitcher agentId="agent-1" chatId="brand-new-chat" agentName="Smithers" />);

    const menu = await screen.findByRole("menu");
    const newChatRow = optimisticRow(menu)!;
    expect(newChatRow).not.toBeNull();
    expect(within(newChatRow).getByText(/Not saved yet/i)).toBeInTheDocument();
    expect(within(newChatRow).queryByText(/year/i)).toBeNull();
  });

  it("re-fetches the chat list every time the dropdown opens", async () => {
    const user = userEvent.setup();
    mockChats(allChats);
    render(<ChatSwitcher agentId="agent-1" chatId="chat-abc" agentName="Smithers" />);

    // Initial mount fetch.
    await screen.findByRole("menu");
    expect(apiGet).toHaveBeenCalledTimes(1);

    // Opening the dropdown triggers a fresh fetch so a just-created session
    // (e.g. from a message sent moments ago) shows up.
    await user.click(screen.getByTestId("open-dropdown"));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(apiGet).toHaveBeenLastCalledWith("/api/agents/agent-1/chats");

    // Re-opening fetches again.
    await user.click(screen.getByTestId("open-dropdown"));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));
  });
});
