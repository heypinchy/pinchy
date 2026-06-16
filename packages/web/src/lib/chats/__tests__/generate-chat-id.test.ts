import { describe, it, expect } from "vitest";
import { generateChatId } from "@/lib/chats/generate-chat-id";
import { chatIdSchema } from "@/lib/schemas/sessions";

describe("generateChatId", () => {
  it("produces an id that satisfies chatIdSchema", () => {
    for (let i = 0; i < 50; i++) {
      const id = generateChatId();
      expect(chatIdSchema.safeParse(id).success).toBe(true);
    }
  });

  it("produces a unique id on each call", () => {
    const a = generateChatId();
    const b = generateChatId();
    expect(a).not.toBe(b);
  });
});
