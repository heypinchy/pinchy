import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { buildOtelSpans } from "@/lib/diagnostics/otel-builder";
import { parseJsonlLines } from "@/lib/diagnostics/jsonl-parser";
import { extractTurns, type Turn } from "@/lib/diagnostics/turn-extractor";

const sampleTurn: Turn = {
  index: 0,
  role: "user",
  userMessage: { text: "hi", timestamp: 1716000000000 },
  assistantResponse: {
    text: "hello",
    finishReason: "stop",
    model: "claude-opus-4-7",
    provider: "anthropic",
    usage: { inputTokens: 10, outputTokens: 5 },
    toolCalls: [
      { toolCallId: "tc1", name: "docs_list", arguments: { q: "x" }, result: { docs: [] } },
    ],
    timestamp: 1716000001000,
  },
};

describe("buildOtelSpans", () => {
  it("maps assistant turn to a gen_ai-attributed span", () => {
    const spans = buildOtelSpans([sampleTurn]);
    expect(spans).toHaveLength(1);
    const attrs = spans[0].attributes;
    expect(attrs["gen_ai.provider.name"]).toBe("anthropic");
    expect(attrs["gen_ai.request.model"]).toBe("claude-opus-4-7");
    expect(attrs["gen_ai.response.finish_reasons"]).toEqual(["stop"]);
    expect(attrs["gen_ai.usage.input_tokens"]).toBe(10);
    expect(attrs["gen_ai.usage.output_tokens"]).toBe(5);
  });

  it("includes input and output messages in OTel shape", () => {
    const spans = buildOtelSpans([sampleTurn]);
    const attrs = spans[0].attributes;
    expect(attrs["gen_ai.input.messages"]).toEqual([
      { role: "user", parts: [{ type: "text", content: "hi" }] },
    ]);
    expect(attrs["gen_ai.output.messages"]).toEqual([
      { role: "assistant", parts: [{ type: "text", content: "hello" }] },
    ]);
  });

  it("includes tool calls with arguments and result", () => {
    const spans = buildOtelSpans([sampleTurn]);
    const attrs = spans[0].attributes;
    expect(attrs["gen_ai.tool.call.arguments"]).toEqual([
      { id: "tc1", name: "docs_list", arguments: { q: "x" } },
    ]);
    expect(attrs["gen_ai.tool.call.result"]).toEqual([
      { id: "tc1", name: "docs_list", result: { docs: [] } },
    ]);
  });

  it("carries turn timing into the span as ISO startTime/endTime", () => {
    // Without timestamps an analyst cannot correlate spans with audit entries
    // or wall-clock logs (v0.5.7 staging finding: spans had no timing at all).
    const spans = buildOtelSpans([sampleTurn]);
    expect(spans[0].startTime).toBe(new Date(1716000000000).toISOString()); // userMessage.timestamp
    expect(spans[0].endTime).toBe(new Date(1716000001000).toISOString()); // assistantResponse.timestamp
  });

  it("omits startTime/endTime when no timestamps are known", () => {
    const minimal: Turn = { index: 0, role: "user", assistantResponse: { text: "hi" } };
    const spans = buildOtelSpans([minimal]);
    expect(spans[0].startTime).toBeUndefined();
    expect(spans[0].endTime).toBeUndefined();
  });

  it("skips turns without an assistant response", () => {
    const userOnly: Turn = { index: 0, role: "user", userMessage: { text: "hi" } };
    expect(buildOtelSpans([userOnly])).toHaveLength(0);
  });

  it("omits gen_ai.* keys when their source fields are undefined", () => {
    const minimal: Turn = {
      index: 0,
      role: "user",
      assistantResponse: { text: "hi" },
      // no userMessage, no finishReason, no usage, no model, no provider, no toolCalls
    };
    const spans = buildOtelSpans([minimal]);
    expect(spans).toHaveLength(1);
    const keys = Object.keys(spans[0].attributes);
    expect(keys).not.toContain("gen_ai.provider.name");
    expect(keys).not.toContain("gen_ai.request.model");
    expect(keys).not.toContain("gen_ai.response.finish_reasons");
    expect(keys).not.toContain("gen_ai.usage.input_tokens");
    expect(keys).not.toContain("gen_ai.usage.output_tokens");
    expect(keys).not.toContain("gen_ai.input.messages");
    expect(keys).not.toContain("gen_ai.tool.call.arguments");
    expect(keys).not.toContain("gen_ai.tool.call.result");
    // gen_ai.output.messages is always emitted (even with empty text); that's intentional
    expect(keys).toContain("gen_ai.output.messages");
  });

  it("produces well-shaped spans when chained from the real fixture", () => {
    const fixture = readFileSync(
      join(__dirname, "fixtures/sample-session.trajectory.jsonl"),
      "utf8"
    );
    const events = parseJsonlLines(fixture);
    const turns = extractTurns(events);
    const spans = buildOtelSpans(turns);

    // One span per assistant-responding turn (the aborted turn has an assistantResponse too,
    // so all five model.completed events produce spans).
    expect(spans.length).toBe(turns.length);

    // Sample-check a tool-using turn — first one in the fixture has pinchy_ls calls.
    const toolSpan = spans.find((s) => Array.isArray(s.attributes["gen_ai.tool.call.arguments"]));
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.attributes["gen_ai.tool.call.arguments"]).toBeInstanceOf(Array);

    // Aborted-turn span: finishReason is "aborted", usage keys absent.
    const abortedSpan = spans.find(
      (s) =>
        s.attributes["gen_ai.response.finish_reasons"] !== undefined &&
        (s.attributes["gen_ai.response.finish_reasons"] as unknown[])[0] === "aborted"
    );
    expect(abortedSpan).toBeDefined();
    const abortedKeys = Object.keys(abortedSpan!.attributes);
    expect(abortedKeys).not.toContain("gen_ai.usage.input_tokens");
    expect(abortedKeys).not.toContain("gen_ai.usage.output_tokens");
  });
});
