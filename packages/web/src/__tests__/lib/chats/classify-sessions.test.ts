import { describe, it, expect } from "vitest";
import { classifyUserSessions, type RawSession } from "@/lib/chats/classify-sessions";

const AGENT = "agt_1";

function webKey(userId: string, ...extra: string[]): string {
  return [`agent`, AGENT, `direct`, userId, ...extra].join(":");
}

describe("classifyUserSessions", () => {
  it("includes the user's web chat with a chatId", () => {
    const sessions: RawSession[] = [
      {
        key: webKey("u-1", "chat-abc"),
        sessionId: "ses_1",
        lastInteractionAt: 1000,
      },
    ];

    const result = classifyUserSessions(sessions, "u-1", new Set());

    expect(result).toEqual([
      {
        sessionId: "ses_1",
        key: webKey("u-1", "chat-abc"),
        origin: "web",
        writable: true,
        chatId: "chat-abc",
        lastInteractionAt: 1000,
      },
    ]);
  });

  it("includes the user's legacy web chat (no chatId) with chatId null", () => {
    const sessions: RawSession[] = [{ key: webKey("u-1"), sessionId: "ses_2", updatedAt: 500 }];

    const result = classifyUserSessions(sessions, "u-1", new Set());

    expect(result).toEqual([
      {
        sessionId: "ses_2",
        key: webKey("u-1"),
        origin: "web",
        writable: true,
        chatId: null,
        lastInteractionAt: 500,
      },
    ]);
  });

  it("matches a mixed-case userId against the lowercased key segment", () => {
    const sessions: RawSession[] = [
      { key: webKey("u-mixed"), sessionId: "ses_3", lastInteractionAt: 7 },
    ];

    const result = classifyUserSessions(sessions, "U-Mixed", new Set());

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("ses_3");
    expect(result[0].origin).toBe("web");
    expect(result[0].writable).toBe(true);
  });

  it("includes a linked Telegram peer chat as read-only", () => {
    const sessions: RawSession[] = [
      { key: webKey("tg-peer-9"), sessionId: "ses_4", lastInteractionAt: 42 },
    ];

    const result = classifyUserSessions(sessions, "u-1", new Set(["tg-peer-9"]));

    expect(result).toEqual([
      {
        sessionId: "ses_4",
        key: webKey("tg-peer-9"),
        origin: "telegram",
        writable: false,
        chatId: null,
        lastInteractionAt: 42,
      },
    ]);
  });

  it("excludes another user's direct key", () => {
    const sessions: RawSession[] = [
      { key: webKey("other-user"), sessionId: "ses_5", lastInteractionAt: 1 },
    ];

    const result = classifyUserSessions(sessions, "u-1", new Set());

    expect(result).toEqual([]);
  });

  it("excludes a Telegram peer that is not in the linked set", () => {
    const sessions: RawSession[] = [
      { key: webKey("tg-peer-unlinked"), sessionId: "ses_6", lastInteractionAt: 1 },
    ];

    const result = classifyUserSessions(sessions, "u-1", new Set(["tg-peer-linked"]));

    expect(result).toEqual([]);
  });

  it("excludes a :cron: key", () => {
    const sessions: RawSession[] = [
      {
        key: `agent:${AGENT}:cron:u-1`,
        sessionId: "ses_7",
        lastInteractionAt: 1,
      },
    ];

    const result = classifyUserSessions(sessions, "u-1", new Set());

    expect(result).toEqual([]);
  });

  it("excludes a :subagent: key", () => {
    const sessions: RawSession[] = [
      {
        key: `agent:${AGENT}:subagent:u-1`,
        sessionId: "ses_8",
        lastInteractionAt: 1,
      },
    ];

    const result = classifyUserSessions(sessions, "u-1", new Set());

    expect(result).toEqual([]);
  });

  it("excludes an agent:<id>:main key", () => {
    const sessions: RawSession[] = [
      { key: `agent:${AGENT}:main`, sessionId: "ses_9", lastInteractionAt: 1 },
    ];

    const result = classifyUserSessions(sessions, "u-1", new Set());

    expect(result).toEqual([]);
  });

  it("excludes a malformed direct key with extra segments (fail closed)", () => {
    const sessions: RawSession[] = [
      {
        key: "agent:a:direct:u:c1:c2",
        sessionId: "ses_10",
        lastInteractionAt: 1,
      },
    ];

    const result = classifyUserSessions(sessions, "u", new Set());

    expect(result).toEqual([]);
  });

  it("security roll-up: returns ONLY user A's entries from a mixed list", () => {
    const sessions: RawSession[] = [
      // user A — web, with chatId
      { key: webKey("user-a", "chat-1"), sessionId: "a-web", lastInteractionAt: 10 },
      // user A — linked Telegram peer
      { key: webKey("tg-a"), sessionId: "a-tg", lastInteractionAt: 11 },
      // user B — web (must be excluded)
      { key: webKey("user-b", "chat-2"), sessionId: "b-web", lastInteractionAt: 12 },
      // user B — Telegram peer not linked to A (must be excluded)
      { key: webKey("tg-b"), sessionId: "b-tg", lastInteractionAt: 13 },
      // cron (must be excluded)
      { key: `agent:${AGENT}:cron:user-a`, sessionId: "cron", lastInteractionAt: 14 },
      // unlinked peer (must be excluded)
      { key: webKey("tg-unknown"), sessionId: "unlinked", lastInteractionAt: 15 },
    ];

    const result = classifyUserSessions(sessions, "User-A", new Set(["tg-a"]));

    const ids = result.map((c) => c.sessionId).sort();
    expect(ids).toEqual(["a-tg", "a-web"]);
    // Defense-in-depth: no other user's or system session leaked through.
    expect(result.some((c) => c.sessionId === "b-web")).toBe(false);
    expect(result.some((c) => c.sessionId === "b-tg")).toBe(false);
    expect(result.some((c) => c.sessionId === "cron")).toBe(false);
    expect(result.some((c) => c.sessionId === "unlinked")).toBe(false);
  });
});
