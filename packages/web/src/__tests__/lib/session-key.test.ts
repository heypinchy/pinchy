import { describe, it, expect } from "vitest";

import { directSessionKey, inboxSessionKey } from "@/lib/session-key";

describe("directSessionKey", () => {
  it("builds the legacy per-user direct key", () => {
    expect(directSessionKey("agent-1", "user-9")).toBe("agent:agent-1:direct:user-9");
  });

  it("appends a chatId segment for a named per-chat session (#508)", () => {
    expect(directSessionKey("agent-1", "user-9", "chat-7")).toBe(
      "agent:agent-1:direct:user-9:chat-7"
    );
  });

  it("omits the chat segment when chatId is undefined", () => {
    expect(directSessionKey("a", "b", undefined)).toBe("agent:a:direct:b");
  });
});

describe("inboxSessionKey", () => {
  it("builds an isolated per-ledger-row key that is not a direct key", () => {
    const key = inboxSessionKey("agent-1", "ledger-42");
    expect(key).toBe("agent:agent-1:inbox:ledger-42");
    // Never collides with the user-chat namespace: `:direct:` must not appear,
    // so chat listing (which keys on `:direct:`) can never surface an inbox run.
    expect(key).not.toContain(":direct:");
  });
});
