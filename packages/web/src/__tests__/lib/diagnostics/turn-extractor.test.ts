import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonlLines } from "@/lib/diagnostics/jsonl-parser";
import { extractTurns } from "@/lib/diagnostics/turn-extractor";

const FIXTURE = readFileSync(join(__dirname, "fixtures/sample-session.trajectory.jsonl"), "utf8");

describe("extractTurns", () => {
  it("groups events into turns starting at each user message", () => {
    const events = parseJsonlLines(FIXTURE);
    const turns = extractTurns(events);
    expect(turns.length).toBeGreaterThan(0);
    expect(turns[0].role).toBe("user");
    expect(turns[0].assistantResponse).toBeDefined();
  });

  it("populates finish_reason, usage, and model on the assistantResponse", () => {
    const events = parseJsonlLines(FIXTURE);
    const turns = extractTurns(events);
    const finalTurn = turns[turns.length - 1];
    expect(finalTurn.assistantResponse?.finishReason).toBeTruthy();
    expect(finalTurn.assistantResponse?.usage?.outputTokens).toBeGreaterThan(0);
    expect(finalTurn.assistantResponse?.model).toBeTruthy();
  });

  it("captures tool calls with name + arguments + result", () => {
    const events = parseJsonlLines(FIXTURE);
    const turns = extractTurns(events);
    const turnsWithTools = turns.filter((t) => (t.assistantResponse?.toolCalls?.length ?? 0) > 0);
    expect(turnsWithTools.length).toBeGreaterThan(0);
    const firstToolCall = turnsWithTools[0].assistantResponse!.toolCalls![0];
    expect(firstToolCall.name).toBeTruthy();
    expect(firstToolCall.arguments).toBeDefined();
  });
});
