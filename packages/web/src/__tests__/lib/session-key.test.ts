import { describe, it, expect } from "vitest";

import { directSessionKey } from "@/lib/session-key";

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
