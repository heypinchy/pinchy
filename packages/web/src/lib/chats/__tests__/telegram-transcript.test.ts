import { describe, it, expect } from "vitest";
import { mapTelegramTranscript } from "@/lib/chats/telegram-transcript";
import type { RawHistoryMessage } from "@/lib/chats/telegram-transcript";

describe("mapTelegramTranscript", () => {
  it("keeps only user/assistant turns and drops tool/system noise", () => {
    const raw: RawHistoryMessage[] = [
      { role: "user", content: "hi", timestamp: 1 },
      { role: "assistant", content: "hello", timestamp: 2 },
      { role: "tool", content: "tool output", timestamp: 3 },
      { role: "system", content: "system prompt", timestamp: 4 },
    ];
    expect(mapTelegramTranscript(raw).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("joins the text parts of an array content and ignores non-text parts", () => {
    const raw: RawHistoryMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "part one" },
          { type: "image", url: "ignored" },
          { type: "text", text: "part two" },
        ],
        timestamp: 1,
      },
    ];
    expect(mapTelegramTranscript(raw)[0].text).toBe("part one part two");
  });

  it("strips <final> protocol tags from assistant text", () => {
    const raw: RawHistoryMessage[] = [
      { role: "assistant", content: "<final>the answer</final>", timestamp: 1 },
    ];
    expect(mapTelegramTranscript(raw)[0].text).toBe("the answer");
  });

  it("strips OpenClaw's [timestamp] prefix from user messages", () => {
    const raw: RawHistoryMessage[] = [
      { role: "user", content: "[2026-06-18 10:00] what's up", timestamp: 1 },
    ];
    expect(mapTelegramTranscript(raw)[0].text).toBe("what's up");
  });

  it("drops messages that are empty after stripping", () => {
    const raw: RawHistoryMessage[] = [
      { role: "assistant", content: "<final></final>", timestamp: 1 },
      { role: "user", content: "real message", timestamp: 2 },
    ];
    expect(mapTelegramTranscript(raw).map((m) => m.text)).toEqual(["real message"]);
  });

  it("drops queued-retry duplicate user messages", () => {
    // Real OpenClaw user messages carry a leading [timestamp]; the queued-retry
    // marker follows it. The non-greedy [timestamp] strip removes only the first
    // bracket, leaving the marker so the startsWith() drop matches.
    const raw: RawHistoryMessage[] = [
      {
        role: "user",
        content:
          "[2026-06-18 10:00] [Queued user message that arrived while the previous turn was still active] dup",
        timestamp: 1,
      },
      { role: "user", content: "[2026-06-18 10:01] kept", timestamp: 2 },
    ];
    expect(mapTelegramTranscript(raw).map((m) => m.text)).toEqual(["kept"]);
  });

  it("falls back to timestamp 0 when OpenClaw omits it", () => {
    const raw: RawHistoryMessage[] = [{ role: "assistant", content: "no time" }];
    expect(mapTelegramTranscript(raw)[0].timestamp).toBe(0);
  });

  it("tolerates a null/undefined content part without throwing", () => {
    // Defensive: OpenClaw doesn't emit null parts today, but a malformed entry
    // must not crash the read-only mirror (fail soft, not throw).
    const raw: RawHistoryMessage[] = [
      {
        role: "assistant",
        content: [null, { type: "text", text: "survives" }, undefined] as unknown,
        timestamp: 1,
      },
    ];
    expect(() => mapTelegramTranscript(raw)).not.toThrow();
    expect(mapTelegramTranscript(raw)[0].text).toBe("survives");
  });
});
