import { describe, it, expect } from "vitest";
import { selectMostRecentWebChatId } from "@/lib/chats/select-most-recent-chat";
import type { ClassifiedChat } from "@/lib/chats/classify-sessions";

function web(chatId: string | null, lastInteractionAt: number): ClassifiedChat {
  return {
    sessionId: `s-${chatId ?? "default"}`,
    key: "k",
    origin: "web",
    writable: true,
    chatId,
    lastInteractionAt,
  };
}
function telegram(lastInteractionAt: number): ClassifiedChat {
  return {
    sessionId: "s-tg",
    key: "k",
    origin: "telegram",
    writable: false,
    chatId: null,
    lastInteractionAt,
  };
}

describe("selectMostRecentWebChatId", () => {
  it("returns null when there are no chats", () => {
    expect(selectMostRecentWebChatId([])).toBeNull();
  });

  it("returns null when the only chat is the default/legacy chat", () => {
    // chatId null → the default chat; redirecting there would loop, so render it.
    expect(selectMostRecentWebChatId([web(null, 100)])).toBeNull();
  });

  it("returns the chatId of the single named chat", () => {
    expect(selectMostRecentWebChatId([web("chat-a", 100)])).toBe("chat-a");
  });

  it("returns the most-recently-interacted named chat", () => {
    expect(
      selectMostRecentWebChatId([web("chat-old", 100), web("chat-new", 200), web("chat-mid", 150)])
    ).toBe("chat-new");
  });

  it("returns null when the default chat is the most recent (render default, no redirect)", () => {
    expect(selectMostRecentWebChatId([web("chat-a", 100), web(null, 200)])).toBeNull();
  });

  it("ignores telegram chats and picks the most recent WEB chat", () => {
    // The most recent chat overall is a read-only Telegram mirror; clicking the
    // agent must not land there — pick the most recent web chat instead.
    expect(selectMostRecentWebChatId([telegram(300), web("chat-a", 200)])).toBe("chat-a");
  });
});
