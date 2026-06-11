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

  it("takes each turn's userMessage timestamp from its paired prompt.submitted event", () => {
    // Real staging finding (bundle 2026-06-11): every span carried the SAME
    // startTime because the extractor read the FIRST snapshot message's
    // timestamp — i.e. the session's first message — for every turn. The
    // trajectory's prompt.submitted events carry the true per-turn submit
    // time and pair with model.completed via runId.
    const events = parseJsonlLines(FIXTURE);
    const turns = extractTurns(events);

    const expected = [
      "2026-05-19T12:00:51.761Z",
      "2026-05-19T12:31:37.955Z",
      "2026-05-19T12:33:04.267Z",
      "2026-05-19T12:42:20.201Z",
      "2026-05-19T13:02:36.041Z",
    ].map((iso) => Date.parse(iso));

    expect(turns.map((t) => t.userMessage?.timestamp)).toEqual(expected);
    // And crucially: the timestamps are per-turn distinct, not all identical.
    expect(new Set(expected).size).toBe(expected.length);
  });

  it("falls back to the latest preceding prompt.submitted when runIds are absent", () => {
    const events = [
      { type: "prompt.submitted", ts: "2026-01-01T10:00:00.000Z" },
      { type: "model.completed", ts: "2026-01-01T10:00:05.000Z", data: {} },
      { type: "prompt.submitted", ts: "2026-01-01T11:00:00.000Z" },
      { type: "model.completed", ts: "2026-01-01T11:00:09.000Z", data: {} },
    ];
    const turns = extractTurns(events);
    expect(turns[0].userMessage?.timestamp).toBe(Date.parse("2026-01-01T10:00:00.000Z"));
    expect(turns[1].userMessage?.timestamp).toBe(Date.parse("2026-01-01T11:00:00.000Z"));
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
    expect(firstToolCall.result).toBeDefined();
  });

  it("returns finishReason='aborted' for the aborted turn, with empty text and no usage", () => {
    const events = parseJsonlLines(FIXTURE);
    const turns = extractTurns(events);
    const aborted = turns.find((t) => t.assistantResponse?.finishReason === "aborted");
    expect(aborted).toBeDefined();
    expect(aborted!.assistantResponse?.text).toBe("");
    expect(aborted!.assistantResponse?.usage).toBeUndefined();
  });
});
